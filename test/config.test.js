import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLACEHOLDER_KEY,
  installedProfileDir,
  loadConfig,
  privateConfigCandidates,
} from '../src/config.js';
import { McpToolError } from '../src/lib/errors.js';

const tempDirs = [];
test.after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-stepaudio-cfg-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一个独立模式私密配置：<profile>/stepaudio/config.json + 目录外 env 文件。 */
async function makePrivateProfile({ key = 'secret-from-file', envExtra = '' } = {}) {
  const profile = await makeTempDir();
  const envFile = path.join(profile, 'provider.env');
  await fs.writeFile(envFile, `STEP_API_KEY=${key}\n${envExtra}`, 'utf8');
  await fs.mkdir(path.join(profile, 'stepaudio'), { recursive: true });
  const configPath = path.join(profile, 'stepaudio', 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({ schemaVersion: 1, mode: 'independent', envFile }),
    'utf8',
  );
  return { profile, envFile, configPath };
}

// ---------- 环境变量直填 ----------

test('默认 stepplan 模式使用 Step Plan base URL', async () => {
  const config = await loadConfig({ STEP_API_KEY: 'k' });
  assert.equal(config.mode, 'stepplan');
  assert.equal(config.baseUrl, 'https://api.stepfun.com/step_plan/v1');
  assert.equal(config.apiKey, 'k');
  assert.equal(config.model, 'stepaudio-2.5-tts');
  assert.match(config.outputDir, /output$/);
});

test('openapi 模式默认开放平台 base URL', async () => {
  const config = await loadConfig({ STEPAUDIO_MODE: 'openapi', STEPFUN_API_KEY: 'k2' });
  assert.equal(config.mode, 'openapi');
  assert.equal(config.baseUrl, 'https://api.stepfun.com/v1');
  assert.equal(config.apiKey, 'k2');
});

test('key 按优先级探测：STEP_API_KEY > STEPFUN_API_KEY > DFSC_STEP_PLAN_API_KEY', async () => {
  assert.equal(
    (await loadConfig({ STEP_API_KEY: 'a', STEPFUN_API_KEY: 'b', DFSC_STEP_PLAN_API_KEY: 'c' })).apiKey,
    'a',
  );
  assert.equal((await loadConfig({ STEPFUN_API_KEY: 'b', DFSC_STEP_PLAN_API_KEY: 'c' })).apiKey, 'b');
  assert.equal((await loadConfig({ DFSC_STEP_PLAN_API_KEY: 'c' })).apiKey, 'c');
  assert.equal((await loadConfig({ STEP_API_KEY: '  ', DFSC_STEP_PLAN_API_KEY: 'c' })).apiKey, 'c');
});

test('缺少 key 抛出 CONFIG_ERROR', async () => {
  await assert.rejects(
    () => loadConfig({}),
    (error) => error instanceof McpToolError && error.code === 'CONFIG_ERROR',
  );
});

test('非法模式抛出 CONFIG_ERROR', async () => {
  await assert.rejects(
    () => loadConfig({ STEPAUDIO_MODE: 'bogus', STEP_API_KEY: 'k' }),
    (error) => error instanceof McpToolError && error.code === 'CONFIG_ERROR',
  );
});

test('STEPAUDIO_BASE_URL 覆盖并去掉尾部斜杠；大小写不敏感的模式', async () => {
  const config = await loadConfig({
    STEPAUDIO_MODE: 'Stepplan',
    STEPAUDIO_BASE_URL: 'https://gw.example.com/api/',
    STEP_API_KEY: 'k',
  });
  assert.equal(config.baseUrl, 'https://gw.example.com/api');
  assert.equal(config.mode, 'stepplan');
});

test('模型与输出目录可覆盖', async () => {
  const config = await loadConfig({
    STEP_API_KEY: 'k',
    STEPAUDIO_MODEL: 'stepaudio-3-tts',
    STEPAUDIO_OUTPUT_DIR: '/tmp/tts-out',
  });
  assert.equal(config.model, 'stepaudio-3-tts');
  assert.equal(config.outputDir, path.resolve('/tmp/tts-out'));
});

// ---------- 私密配置（市场安装场景） ----------

test('占位符 key 视为未配置，穿透到私密配置', async () => {
  const { profile } = await makePrivateProfile({
    envExtra: 'STEPAUDIO_BASE_URL=https://api.stepfun.com/v1\nSTEPAUDIO_MODEL=step-tts-2\n',
  });
  const config = await loadConfig(
    { STEP_API_KEY: PLACEHOLDER_KEY, STEPAUDIO_PROFILE_DIR: profile },
    { pluginRoot: await makeTempDir() },
  );
  assert.equal(config.apiKey, 'secret-from-file');
  assert.equal(config.baseUrl, 'https://api.stepfun.com/v1');
  assert.equal(config.model, 'step-tts-2');
  assert.equal(config.mode, 'stepplan'); // 未显式设置模式时取默认；显式 base URL 优先生效
});

test('安装布局自动发现 <step-runtime>/stepaudio/config.json', async () => {
  const stepRuntime = await makeTempDir();
  const pluginRoot = path.join(stepRuntime, 'plugins', 'dfsc-stepaudio');
  await fs.mkdir(pluginRoot, { recursive: true });
  const nested = await makePrivateProfile({ key: 'installed-layout-key' });
  await fs.mkdir(path.join(stepRuntime, 'stepaudio'), { recursive: true });
  await fs.copyFile(nested.configPath, path.join(stepRuntime, 'stepaudio', 'config.json'));

  const config = await loadConfig({ STEP_API_KEY: PLACEHOLDER_KEY }, { pluginRoot });
  assert.equal(config.apiKey, 'installed-layout-key');
  assert.equal(installedProfileDir(pluginRoot), stepRuntime);
});

test('占位符写在宿主注入变量 STEPFUN_API_KEY 上时同样穿透到私密配置', async () => {
  const { profile } = await makePrivateProfile();
  const config = await loadConfig(
    { STEPFUN_API_KEY: PLACEHOLDER_KEY, STEPAUDIO_PROFILE_DIR: profile },
    { pluginRoot: await makeTempDir() },
  );
  assert.equal(config.apiKey, 'secret-from-file');
});

test('任一候选变量为占位符时，不使用其他变量中的宿主凭据', async () => {
  // STEP_API_KEY 是占位符、STEPFUN_API_KEY 看似真实 key：必须穿透到私密配置，
  // 不能因为“另一个变量有值”就把宿主凭据用起来
  const { profile } = await makePrivateProfile({ key: 'from-private-config' });
  const config = await loadConfig(
    { STEP_API_KEY: PLACEHOLDER_KEY, STEPFUN_API_KEY: 'host-injected-key', STEPAUDIO_PROFILE_DIR: profile },
    { pluginRoot: await makeTempDir() },
  );
  assert.equal(config.apiKey, 'from-private-config');
});

test('STEPAUDIO_CONFIG_PATH 优先于安装布局', async () => {
  const explicit = await makePrivateProfile({ key: 'explicit-key' });
  const config = await loadConfig({ STEPAUDIO_CONFIG_PATH: explicit.configPath }, { pluginRoot: await makeTempDir() });
  assert.equal(config.apiKey, 'explicit-key');
});

test('privateConfigCandidates 按优先级排列', async () => {
  const candidates = privateConfigCandidates(
    { STEPAUDIO_CONFIG_PATH: 'C:\\cfg.json', STEPAUDIO_PROFILE_DIR: 'D:\\profile' },
    path.join(os.tmpdir(), 'plugins', 'dfsc-stepaudio'),
  );
  assert.equal(candidates[0], path.resolve('C:\\cfg.json'));
  assert.equal(candidates[1], path.join(path.resolve('D:\\profile'), 'stepaudio', 'config.json'));
  // 未设置 profile 时回退安装布局推导
  const fallback = privateConfigCandidates({}, path.join(os.tmpdir(), 'rt', 'plugins', 'dfsc-stepaudio'));
  assert.equal(fallback[0], path.join(path.resolve(os.tmpdir(), 'rt'), 'stepaudio', 'config.json'));
  // 非安装布局且未设置时不产生候选
  assert.deepEqual(privateConfigCandidates({}, path.join(os.tmpdir(), 'elsewhere')), []);
});

test('mode=dfsc（schemaVersion 2）返回桥接不支持错误', async () => {
  const profile = await makeTempDir();
  const envFile = path.join(profile, 'provider.env');
  await fs.writeFile(envFile, 'STEP_API_KEY=x\n');
  await fs.mkdir(path.join(profile, 'stepaudio'), { recursive: true });
  const configPath = path.join(profile, 'stepaudio', 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({ schemaVersion: 2, mode: 'dfsc', hostAccess: 'confirm', envFile }),
  );
  await assert.rejects(
    () => loadConfig({ STEPAUDIO_CONFIG_PATH: configPath }),
    (error) => error instanceof McpToolError && /桥接/.test(error.message),
  );
});

test('env 文件位于插件目录内被拒绝', async () => {
  const pluginRoot = await makeTempDir();
  const envFile = path.join(pluginRoot, 'provider.env');
  await fs.writeFile(envFile, 'STEP_API_KEY=inside\n');
  const profile = await makeTempDir();
  await fs.mkdir(path.join(profile, 'stepaudio'), { recursive: true });
  const configPath = path.join(profile, 'stepaudio', 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, mode: 'independent', envFile }));
  await assert.rejects(
    () => loadConfig({ STEPAUDIO_CONFIG_PATH: configPath }, { pluginRoot }),
    (error) => error instanceof McpToolError && /插件目录之外/.test(error.message),
  );
});

test('私密 env 文件缺少 key 报错', async () => {
  const profile = await makeTempDir();
  const envFile = path.join(profile, 'provider.env');
  await fs.writeFile(envFile, '# 只有注释\nSTEPAUDIO_BASE_URL=https://api.stepfun.com/v1\n');
  await fs.mkdir(path.join(profile, 'stepaudio'), { recursive: true });
  const configPath = path.join(profile, 'stepaudio', 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, mode: 'independent', envFile }));
  await assert.rejects(
    () => loadConfig({ STEPAUDIO_CONFIG_PATH: configPath }),
    (error) => error instanceof McpToolError && /API Key/.test(error.message),
  );
});

test('config.json 非法 JSON 报错', async () => {
  const profile = await makeTempDir();
  await fs.mkdir(path.join(profile, 'stepaudio'), { recursive: true });
  const configPath = path.join(profile, 'stepaudio', 'config.json');
  await fs.writeFile(configPath, '{ not json');
  await assert.rejects(
    () => loadConfig({ STEPAUDIO_CONFIG_PATH: configPath }),
    (error) => error instanceof McpToolError && /JSON/.test(error.message),
  );
});

test('只有占位符且无任何私密配置时，错误信息指引 configure.mjs', async () => {
  const pluginRoot = await makeTempDir();
  await assert.rejects(
    () => loadConfig({ STEP_API_KEY: PLACEHOLDER_KEY }, { pluginRoot }),
    (error) =>
      error instanceof McpToolError &&
      error.code === 'CONFIG_ERROR' &&
      /configure\.mjs/.test(error.message),
  );
});
