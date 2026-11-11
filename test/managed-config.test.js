import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isManagedInstall, PLACEHOLDER_KEYS } from '../src/config.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTANCE = 'a1b2c3d4-1234-1234-1234-123456789abc';
const REVISION = 'a'.repeat(64);
const PLUGIN_ID = 'dfsc-stepaudio';

const tempDirs = [];
test.after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 与官方读取器逐字节对齐的包指纹：条目按 localeCompare 排序，digest.update(JSON.stringify([相对路径, 字节长度])) + 内容。 */
async function fingerprintPackage(root) {
  const digest = createHash('sha256');
  async function visit(relative = '') {
    const entries = (await readdir(relative ? path.join(root, relative) : root, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), '包内不允许符号链接');
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else {
        const bytes = await readFile(path.join(root, child));
        digest.update(JSON.stringify([child, bytes.length])).update(bytes);
      }
    }
  }
  await visit();
  return digest.digest('hex');
}

/**
 * 构造托管布局：
 * <root>/plugins/dfsc-stepaudio/            （包：step.plugin.json + dfsc.settings.json 真实副本）
 * <root>/desktop-plugins/bindings/dfsc-stepaudio.json
 * <root>/desktop-plugins/installations.json
 * <root>/desktop-plugins/settings/<instance>/<revision>.json
 */
async function createManagedLayout({ values = {}, secrets = {}, withSnapshot = true } = {}) {
  const root = await makeTempDir('dfsc-stepaudio-managed-');
  const pkg = path.join(root, 'plugins', PLUGIN_ID);
  await mkdir(pkg, { recursive: true });
  await copyFile(path.join(PLUGIN_ROOT, 'step.plugin.json'), path.join(pkg, 'step.plugin.json'));
  const settingsBytes = await readFile(path.join(PLUGIN_ROOT, 'dfsc.settings.json'));
  await writeFile(path.join(pkg, 'dfsc.settings.json'), settingsBytes);

  const schemaHash = sha256(settingsBytes);
  const snapshot = {
    version: 1,
    instance: INSTANCE,
    id: PLUGIN_ID,
    revision: REVISION,
    schemaHash,
    values,
    secrets,
  };
  const settingsDir = path.join(root, 'desktop-plugins', 'settings', INSTANCE);
  await mkdir(settingsDir, { recursive: true });
  if (withSnapshot) {
    await writeFile(path.join(settingsDir, `${REVISION}.json`), JSON.stringify(snapshot));
  }

  const contentHash = sha256(JSON.stringify(JSON.parse(JSON.stringify(snapshot))));
  const fingerprint = await fingerprintPackage(pkg);
  const binding = {
    version: 1,
    instance: INSTANCE,
    id: PLUGIN_ID,
    revision: REVISION,
    schemaHash,
    contentHash,
    fingerprint,
  };
  await mkdir(path.join(root, 'desktop-plugins', 'bindings'), { recursive: true });
  await writeFile(path.join(root, 'desktop-plugins', 'bindings', `${PLUGIN_ID}.json`), JSON.stringify(binding));
  await writeFile(
    path.join(root, 'desktop-plugins', 'installations.json'),
    JSON.stringify({
      version: 1,
      installations: [{ instance: INSTANCE, folder: PLUGIN_ID, id: PLUGIN_ID, state: 'installed', fingerprint }],
    }),
  );
  return { root, pkg };
}

test('托管布局：使用宿主设置，环境变量一律不参与', async () => {
  const outputDir = await makeTempDir('dfsc-stepaudio-out-');
  const { pkg } = await createManagedLayout({
    values: {
      mode: 'openapi',
      base_url: 'https://api.test/v1',
      model: 'step-tts-2',
      output_dir: outputDir,
      voice: 'cixingnansheng',
      instruction: '语气温柔，语速偏慢',
      response_format: 'wav',
    },
    secrets: { api_key: 'host-managed-key' },
  });

  const config = await loadConfig(
    { STEP_API_KEY: 'env-key-must-be-ignored', STEPAUDIO_MODE: 'stepplan', STEPAUDIO_PROFILE_DIR: 'C:/nonexistent' },
    { pluginRoot: pkg },
  );
  assert.equal(config.apiKey, 'host-managed-key');
  assert.equal(config.mode, 'openapi');
  assert.equal(config.baseUrl, 'https://api.test/v1');
  assert.equal(config.model, 'step-tts-2');
  assert.equal(config.outputDir, path.resolve(outputDir));
  assert.equal(config.voice, 'cixingnansheng');
  assert.equal(config.instruction, '语气温柔，语速偏慢');
  assert.equal(config.responseFormat, 'wav');
  assert.equal(config.managed, true);
  assert.equal(config.revision, REVISION);
  assert.ok(config.reader, '返回读取器实例供调用前复审');
});

test('托管布局：空值按未设置处理（走默认）', async () => {
  const { pkg } = await createManagedLayout({
    values: { mode: '', base_url: '', model: '', voice: '', instruction: '', response_format: '' },
    secrets: { api_key: 'k' },
  });
  const config = await loadConfig({}, { pluginRoot: pkg });
  assert.equal(config.mode, 'stepplan');
  assert.equal(config.baseUrl, 'https://api.stepfun.com/step_plan/v1');
  assert.equal(config.model, 'stepaudio-2.5-tts');
  assert.equal(config.responseFormat, 'mp3');
  assert.equal(config.voice, '');
  assert.equal(config.instruction, '');
  // 托管布局默认输出目录不得在包内
  assert.ok(!config.outputDir.startsWith(pkg), '托管默认输出目录在包外');
});

test('托管布局：读取失败 fail-closed，不回落 env 或 CLI', async () => {
  const { pkg } = await createManagedLayout({ values: {}, secrets: {}, withSnapshot: false });
  await assert.rejects(
    () => loadConfig({ STEP_API_KEY: 'env-key' }, { pluginRoot: pkg }),
    (error) => /宿主配置不可用或已变更/.test(error.message),
  );
});

test('托管布局：设置缺少 API Key 时给出插件中心指引', async () => {
  const { pkg } = await createManagedLayout({ values: { mode: 'stepplan' }, secrets: {} });
  await assert.rejects(
    () => loadConfig({}, { pluginRoot: pkg }),
    (error) => /插件中心/.test(error.message) && /API Key/.test(error.message),
  );
});

test('托管布局：输出目录指向包内被拒绝', async () => {
  const { pkg } = await createManagedLayout({
    values: { output_dir: 'output' },
    secrets: { api_key: 'k' },
  });
  await assert.rejects(
    () => loadConfig({}, { pluginRoot: pkg }),
    (error) => /不能位于插件包内/.test(error.message),
  );
});

test('托管布局：包内文件被改动后指纹失配（fail-closed）', async () => {
  const { pkg } = await createManagedLayout({ values: {}, secrets: { api_key: 'k' } });
  await writeFile(path.join(pkg, 'extra.txt'), 'tamper');
  await assert.rejects(
    () => loadConfig({ STEP_API_KEY: 'env-key' }, { pluginRoot: pkg }),
    (error) => /宿主配置不可用或已变更/.test(error.message),
  );
});

test('isManagedInstall：plugins 布局 + desktop-plugins 存在才算托管', async () => {
  const { pkg, root } = await createManagedLayout({ values: {}, secrets: { api_key: 'k' } });
  assert.equal(isManagedInstall(pkg), true);
  assert.equal(isManagedInstall(root), false);
  // 本地开发克隆：位于 plugins/ 下但没有宿主数据目录 → 非托管
  const devClone = path.join(await makeTempDir('dfsc-stepaudio-dev-'), 'plugins', 'dfsc-stepaudio');
  await mkdir(devClone, { recursive: true });
  assert.equal(isManagedInstall(devClone), false);
});

test('哨兵集合：官方值与历史值都视为未配置', async () => {
  assert.ok(PLACEHOLDER_KEYS.includes('DFSC_INDEPENDENT_PLUGIN'));
  assert.ok(PLACEHOLDER_KEYS.includes('stepaudio-managed-provider-context'));
  assert.equal(new Set(PLACEHOLDER_KEYS).size, PLACEHOLDER_KEYS.length, '无重复值');
});
