import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpToolError } from './lib/errors.js';
import { parseEnvFile } from './lib/env-file.js';

/** 支持的 TTS 模型（阶跃开放平台文档，2026-11）。 */
export const KNOWN_MODELS = [
  'stepaudio-3-tts',
  'stepaudio-2.5-tts',
  'step-tts-2',
  'step-tts-mini',
];

export const MODES = ['stepplan', 'openapi'];

/**
/**
 * step.plugin.json 的 mcpServers.env 占位符。
 * 约定（对齐 BVR 插件）：占位符必须写在宿主自动注入登录凭据所使用的变量
 * STEPFUN_API_KEY 上——写在其他变量名（如 STEP_API_KEY）无法阻止宿主把真实
 * 凭据注入 MCP 子进程，占位符就失去了“阻止注入”的作用。
 * 取值等于占位符时视为“未配置”，转去读插件目录外的私密配置。
 */
export const PLACEHOLDER_KEY = 'stepaudio-managed-provider-context';

const DEFAULT_BASE_URLS = {
  // 沿用 Step Plan 登录态额度
  stepplan: 'https://api.stepfun.com/step_plan/v1',
  // 开放平台 / 任意 OpenAI 兼容服务
  openapi: 'https://api.stepfun.com/v1',
};

/**
 * API key 的候选变量名，按优先级探测。
 * 注意顺序语义：任一变量取值等于 PLACEHOLDER_KEY 即整体视为未配置，
 * 因此宿主注入变量（STEPFUN_API_KEY）即使被占位符占住，也不会误用真实凭据。
 */
const API_KEY_ENV_CANDIDATES = ['STEP_API_KEY', 'STEPFUN_API_KEY', 'DFSC_STEP_PLAN_API_KEY'];
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ENV_FILE_BYTES = 128 * 1024;

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

function buildConfig(settings) {
  const mode = normalizeMode(settings.STEPAUDIO_MODE);
  const baseUrl = (settings.STEPAUDIO_BASE_URL?.trim() || DEFAULT_BASE_URLS[mode]).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new McpToolError(`base URL 不合法（需以 http(s):// 开头）：${baseUrl}`, { code: 'CONFIG_ERROR' });
  }
  const apiKey = settings.apiKey.trim();
  if (apiKey === '') {
    throw new McpToolError('API Key 不能为空', { code: 'CONFIG_ERROR' });
  }
  return {
    mode,
    baseUrl,
    apiKey,
    model: settings.STEPAUDIO_MODEL?.trim() || 'stepaudio-2.5-tts',
    outputDir: path.resolve(settings.STEPAUDIO_OUTPUT_DIR?.trim() || path.join(PLUGIN_ROOT, 'output')),
  };
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
    ? '检测到跟随 DFSC 占位符，但未找到可用的私密配置。'
    : '未找到 API Key 或私密配置。';
  throw new McpToolError(
    `${reason}独立模式配置方法：将 provider.example 复制到插件目录以外的私密位置并填入 Key，` +
      `然后运行 node scripts/configure.mjs --profile <目录> --mode independent --env-file <该文件绝对路径>。` +
      `预期配置位置：${expected}。`,
    { code: 'CONFIG_ERROR' },
  );
}

/**
 * 加载配置。解析链：
 * 1. 环境变量直填（开发直连 / DFSC 注入真实 Key）；占位符视为未配置；
 * 2. 插件目录外的私密配置（config.json + env 文件），对应市场安装场景；
 * 3. 都不可用时报 CONFIG_ERROR，并给出独立模式配置方法。
 */
export async function loadConfig(env = process.env, options = {}) {
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;

  const directKey = firstNonEmpty(env, API_KEY_ENV_CANDIDATES);
  if (directKey && directKey !== PLACEHOLDER_KEY) {
    return buildConfig({ ...env, apiKey: directKey });
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
  if (existing.length === 0) throw missingConfigError(directKey === PLACEHOLDER_KEY, candidates);

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
      '跟随 DFSC 模式需要 DFSC 宿主提供 StepAudio 桥接（host.json），当前宿主不支持该桥接。' +
        '请改用独立模式：node scripts/configure.mjs --profile <目录> --mode independent --env-file <私密 env 文件>。',
      { code: 'CONFIG_ERROR' },
    );
  }
  const independent =
    parsed?.schemaVersion === 1 || (parsed?.schemaVersion === 2 && parsed.mode === 'independent');
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
  if (!key || key === PLACEHOLDER_KEY) {
    throw new McpToolError(
      `私密 env 文件未设置 API Key（${API_KEY_ENV_CANDIDATES.join(' 或 ')}）：${envFile}`,
      { code: 'CONFIG_ERROR' },
    );
  }
  return buildConfig({ ...settings, apiKey: key });
}
