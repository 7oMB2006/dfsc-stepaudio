import path from 'node:path';
import os from 'node:os';
import { statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpToolError } from './lib/errors.js';
import { parseEnvFile } from './lib/env-file.js';
import { ConfigurationReader } from './lib/dfsc-config.mjs';

/** 支持的 TTS 模型（阶跃开放平台文档，2026-11）。 */
export const KNOWN_MODELS = [
  'stepaudio-3-tts',
  'stepaudio-2.5-tts',
  'step-tts-2',
  'step-tts-mini',
];

export const MODES = ['stepplan', 'openapi'];

/** 输出格式（API 的 response_format）。 */
export const RESPONSE_FORMATS = ['mp3', 'wav', 'flac', 'opus', 'pcm'];

/**
 * 哨兵值：占位符写在上游宿主自动注入登录凭据的变量（STEPFUN_API_KEY）上，
 * 取值等于任一已知哨兵时视为“未配置”。官方值为 DFSC_INDEPENDENT_PLUGIN；
 * 历史自定义值永久保留识别，避免残留环境变量被当作真实 Key 使用。
 */
export const PLACEHOLDER_KEY = 'DFSC_INDEPENDENT_PLUGIN';
export const PLACEHOLDER_KEYS = ['DFSC_INDEPENDENT_PLUGIN', 'stepaudio-managed-provider-context'];

const DEFAULT_BASE_URLS = {
  // 沿用 Step Plan 登录态额度
  stepplan: 'https://api.stepfun.com/step_plan/v1',
  // 开放平台 / 任意 OpenAI 兼容服务
  openapi: 'https://api.stepfun.com/v1',
};

/** API key 的候选变量名，按优先级探测（仅非托管布局生效）。 */
const API_KEY_ENV_CANDIDATES = ['STEP_API_KEY', 'STEPFUN_API_KEY', 'DFSC_STEP_PLAN_API_KEY'];

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ENV_FILE_BYTES = 128 * 1024;

/** 插件根目录 → 供 ConfigurationReader 使用的目录 URL。 */
function packageUrlFor(pluginRoot) {
  return new URL('./', pathToFileURL(path.join(path.resolve(pluginRoot), 'package.json')));
}

function firstNonEmpty(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function normalizeMode(raw) {
  const mode = String(raw ?? 'stepplan').trim().toLowerCase();
  if (!MODES.includes(mode)) {
    throw new McpToolError(`未知的后端模式 "${raw}"，可选值：${MODES.join(' / ')}`, { code: 'CONFIG_ERROR' });
  }
  return mode;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 安装布局 <step-runtime>/plugins/<插件名> 时返回 <step-runtime>，否则 null。 */
export function installedProfileDir(pluginRoot = PLUGIN_ROOT) {
  const parent = path.dirname(path.resolve(pluginRoot));
  return path.basename(parent) === 'plugins' ? path.dirname(parent) : null;
}

/**
 * 托管安装判定：插件位于 <root>/plugins/<folder> 且同级存在宿主数据目录 desktop-plugins/。
 * 仅凭位于 plugins/ 下不算托管（本地开发克隆同样可能在此布局），必须有宿主数据目录证据。
 */
export function isManagedInstall(pluginRoot = PLUGIN_ROOT) {
  const root = installedProfileDir(pluginRoot);
  if (!root) return false;
  try {
    statSync(path.join(root, 'desktop-plugins'));
    return true;
  } catch {
    return false;
  }
}

function resolveOutputDir(outputDir, managed) {
  if (typeof outputDir === 'string' && outputDir.trim() !== '') {
    const resolved = path.resolve(outputDir.trim());
    if (managed && isInside(PLUGIN_ROOT, resolved)) {
      throw new McpToolError(
        `输出目录不能位于插件包内（会破坏安装完整性校验）：${resolved}`,
        { code: 'CONFIG_ERROR' },
      );
    }
    return resolved;
  }
  // 托管布局默认落系统临时目录（写入包内会改变包指纹导致配置校验失败）；本地开发保持包内 output/
  return managed
    ? path.join(os.tmpdir(), 'dfsc-stepaudio-output')
    : path.join(PLUGIN_ROOT, 'output');
}

/** 由显式字段构建配置（env / CLI 私密配置 / 宿主设置三条来源共用）。 */
function buildConfig(fields) {
  // 空串按“未设置”处理（宿主设置与 env 文件的惯例），走默认值
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const mode = normalizeMode(pick(fields.mode));
  const baseUrl = (pick(fields.baseUrl) || DEFAULT_BASE_URLS[mode]).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new McpToolError(`base URL 不合法（需以 http(s):// 开头）：${baseUrl}`, { code: 'CONFIG_ERROR' });
  }
  const apiKey = (fields.apiKey ?? '').trim();
  if (apiKey === '') {
    throw new McpToolError('API Key 不能为空', { code: 'CONFIG_ERROR' });
  }
  const model = pick(fields.model) || 'stepaudio-2.5-tts';
  const responseFormat = (pick(fields.responseFormat) || 'mp3').toLowerCase();
  if (!RESPONSE_FORMATS.includes(responseFormat)) {
    throw new McpToolError(
      `输出格式不合法：${fields.responseFormat}，可选值：${RESPONSE_FORMATS.join(' / ')}`,
      { code: 'CONFIG_ERROR' },
    );
  }
  return {
    mode,
    baseUrl,
    apiKey,
    model,
    responseFormat,
    outputDir: resolveOutputDir(pick(fields.outputDir), fields.managed === true),
    voice: pick(fields.voice) || '',
    instruction: pick(fields.instruction) || '',
    managed: fields.managed === true,
    revision: fields.revision ?? null,
    pluginRoot: PLUGIN_ROOT,
  };
}

function managedFailure() {
  return new McpToolError(
    '宿主配置不可用或已变更。请在 DFSC 插件中心重新保存本插件配置，然后重启服务；'
      + '托管安装下不使用环境变量或外部配置文件。',
    { code: 'CONFIG_ERROR' },
  );
}

/** 托管布局：只信宿主设置。读取失败一律 fail-closed，不回落 env 或 CLI 配置。 */
async function loadManagedConfig(pluginRoot) {
  const reader = new ConfigurationReader(packageUrlFor(pluginRoot));
  const bindingPath = path.join(reader.root, 'desktop-plugins', 'bindings', `${reader.folder}.json`);
  let hasBinding = false;
  try {
    await fs.access(bindingPath);
    hasBinding = true;
  } catch {
    hasBinding = false;
  }
  if (!hasBinding) {
    // 宿主安装了插件但没有为本插件写入配置绑定：说明当前宿主不支持声明式设置
    // （或插件未通过正常流程安装）。此时不回落 env——托管安装下环境变量一律不参与。
    throw new McpToolError(
      '当前 DFSC 宿主未对本插件提供声明式配置支持（未找到配置绑定）。请升级到支持插件中心配置的 DFSC 版本；'
        + '托管安装下不使用环境变量或外部配置文件。',
      { code: 'CONFIG_ERROR' },
    );
  }
  let snapshot;
  try {
    snapshot = await reader.current();
  } catch {
    throw managedFailure();
  }
  const values = snapshot.values ?? {};
  const secrets = snapshot.secrets ?? {};
  const apiKey = typeof secrets.api_key === 'string' ? secrets.api_key.trim() : '';
  if (apiKey === '') {
    throw new McpToolError(
      '宿主配置中缺少 API Key：请在 DFSC 插件中心打开本插件配置页填写后保存，并重启服务。',
      { code: 'CONFIG_ERROR' },
    );
  }
  const config = buildConfig({
    mode: values.mode,
    baseUrl: values.base_url,
    model: values.model,
    apiKey,
    outputDir: values.output_dir,
    voice: values.voice,
    instruction: values.instruction,
    responseFormat: values.response_format,
    managed: true,
    revision: snapshot.revision,
  });
  config.reader = reader;
  return config;
}

/** 私密配置（config.json）的候选位置，按优先级。 */
export function privateConfigCandidates(env = process.env, pluginRoot = PLUGIN_ROOT) {
  const candidates = [];
  if (typeof env.STEPAUDIO_CONFIG_PATH === 'string' && env.STEPAUDIO_CONFIG_PATH.trim() !== '') {
    candidates.push(path.resolve(env.STEPAUDIO_CONFIG_PATH.trim()));
  }
  const profile =
    typeof env.STEPAUDIO_PROFILE_DIR === 'string' && env.STEPAUDIO_PROFILE_DIR.trim() !== ''
      ? path.resolve(env.STEPAUDIO_PROFILE_DIR.trim())
      : installedProfileDir(pluginRoot);
  if (profile) candidates.push(path.join(profile, 'stepaudio', 'config.json'));
  return candidates;
}

async function readBoundedText(filePath, limit, label) {
  let info;
  try {
    info = await fs.stat(filePath);
  } catch {
    throw new McpToolError(`${label}不存在：${filePath}`, { code: 'CONFIG_ERROR' });
  }
  if (!info.isFile() || info.size > limit) {
    throw new McpToolError(`${label}不是可读取的文件或超过大小上限：${filePath}`, { code: 'CONFIG_ERROR' });
  }
  return fs.readFile(filePath, 'utf8');
}

function missingConfigError(placeholderSeen, candidates) {
  const expected = candidates[0] ?? '<profile>/stepaudio/config.json';
  const reason = placeholderSeen
    ? '检测到占位符（未配置独立 Key），且未找到可用的私密配置。'
    : '未找到 API Key 或私密配置。';
  throw new McpToolError(
    `${reason}配置方法：DFSC 内请在插件中心本插件配置页填写；其他场景将 provider.example 复制到插件目录以外的私密位置并填入 Key，`
      + `然后运行 node scripts/configure.mjs --profile <目录> --mode independent --env-file <该文件绝对路径>。`
      + `预期配置位置：${expected}。`,
    { code: 'CONFIG_ERROR' },
  );
}

/**
 * 加载配置。解析链：
 * 1. 托管安装（位于 <root>/plugins/<folder> 且存在 desktop-plugins/）：只读宿主设置，
 *    环境变量与 CLI 私密配置一律不参与；读取失败 fail-closed。
 * 2. 非托管：环境变量直填（哨兵值视为未配置）。
 * 3. 非托管：插件目录外的 CLI 私密配置。
 * 4. 都不可用 → CONFIG_ERROR，附两种配置方法的指引。
 */
export async function loadConfig(env = process.env, options = {}) {
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;

  if (isManagedInstall(pluginRoot)) {
    return loadManagedConfig(pluginRoot);
  }

  const directKey = firstNonEmpty(env, API_KEY_ENV_CANDIDATES);
  if (directKey && !PLACEHOLDER_KEYS.includes(directKey)) {
    return buildConfig({
      mode: env.STEPAUDIO_MODE,
      baseUrl: env.STEPAUDIO_BASE_URL,
      model: env.STEPAUDIO_MODEL,
      apiKey: directKey,
      outputDir: env.STEPAUDIO_OUTPUT_DIR,
      voice: env.STEPAUDIO_VOICE,
      instruction: env.STEPAUDIO_INSTRUCTION,
      responseFormat: env.STEPAUDIO_RESPONSE_FORMAT,
    });
  }

  const candidates = privateConfigCandidates(env, pluginRoot);
  const existing = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      existing.push(candidate);
    } catch {
      // 候选不存在，继续找
    }
  }
  if (existing.length === 0) {
    throw missingConfigError(PLACEHOLDER_KEYS.includes(directKey ?? ''), candidates);
  }

  const configPath = existing[0];
  const raw = await readBoundedText(configPath, MAX_CONFIG_BYTES, '私密配置文件');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpToolError(`私密配置文件不是合法 JSON：${configPath}`, { code: 'CONFIG_ERROR' });
  }
  if (parsed?.schemaVersion === 2 && parsed.mode === 'dfsc') {
    throw new McpToolError(
      '私密配置声明了跟随 DFSC 模式（mode=dfsc）：本插件不走宿主账户桥接，请在 DFSC 插件中心配置，或改用独立 Key。',
      { code: 'CONFIG_ERROR' },
    );
  }
  const independent = parsed?.schemaVersion === 1 || (parsed?.schemaVersion === 2 && parsed.mode === 'independent');
  if (!independent) {
    throw new McpToolError(
      `私密配置的 schemaVersion/mode 不受支持（当前 schemaVersion=${parsed?.schemaVersion}, mode=${parsed?.mode}）：${configPath}`,
      { code: 'CONFIG_ERROR' },
    );
  }
  if (typeof parsed.envFile !== 'string' || parsed.envFile.trim() === '') {
    throw new McpToolError(`私密配置缺少 envFile 字段：${configPath}`, { code: 'CONFIG_ERROR' });
  }

  const envFile = path.resolve(parsed.envFile.trim());
  if (isInside(pluginRoot, envFile)) {
    throw new McpToolError(
      `私密 env 文件必须位于插件目录之外（当前指向插件目录内）：${envFile}`,
      { code: 'CONFIG_ERROR' },
    );
  }

  const settings = parseEnvFile(await readBoundedText(envFile, MAX_ENV_FILE_BYTES, '私密 env 文件'));
  const key = firstNonEmpty(settings, API_KEY_ENV_CANDIDATES);
  if (!key || PLACEHOLDER_KEYS.includes(key)) {
    throw new McpToolError(
      `私密 env 文件未设置 API Key（${API_KEY_ENV_CANDIDATES.join(' 或 ')}）：${envFile}`,
      { code: 'CONFIG_ERROR' },
    );
  }
  return buildConfig({
    mode: settings.STEPAUDIO_MODE,
    baseUrl: settings.STEPAUDIO_BASE_URL,
    model: settings.STEPAUDIO_MODEL,
    apiKey: key,
    outputDir: settings.STEPAUDIO_OUTPUT_DIR,
    voice: settings.STEPAUDIO_VOICE,
    instruction: settings.STEPAUDIO_INSTRUCTION,
    responseFormat: settings.STEPAUDIO_RESPONSE_FORMAT,
  });
}
