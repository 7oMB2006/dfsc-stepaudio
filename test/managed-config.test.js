import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isManagedInstall, PLACEHOLDER_KEYS } from '../src/config.js';
import {
  PLUGIN_ROOT,
  cleanupTempDirs,
  createManagedLayout,
  makeTempDir,
} from './helpers/managed-layout.mjs';

test.after(async () => {
  await cleanupTempDirs();
});

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
  assert.equal(config.revision, 'a'.repeat(64));
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
  const { pkg } = await createManagedLayout({ values: { output_dir: 'output' }, secrets: { api_key: 'k' } });
  await assert.rejects(
    () => loadConfig({}, { pluginRoot: pkg }),
    (error) => /不能位于插件包内/.test(error.message),
  );
});

test('托管布局：包内文件被改动后指纹失配（fail-closed）', async () => {
  const { pkg } = await createManagedLayout({ values: {}, secrets: { api_key: 'k' } });
  await fs.writeFile(path.join(pkg, 'extra.txt'), 'tamper');
  await assert.rejects(
    () => loadConfig({ STEP_API_KEY: 'env-key' }, { pluginRoot: pkg }),
    (error) => /宿主配置不可用或已变更/.test(error.message),
  );
});

test('isManagedInstall：plugins 布局 + desktop-plugins 存在才算托管', async () => {
  const { pkg, root } = await createManagedLayout({ values: {}, secrets: { api_key: 'k' } });
  assert.equal(isManagedInstall(pkg), true);
  assert.equal(isManagedInstall(root), false);
  const devClone = path.join(await makeTempDir('dfsc-stepaudio-dev-'), 'plugins', 'dfsc-stepaudio');
  await fs.mkdir(devClone, { recursive: true });
  assert.equal(isManagedInstall(devClone), false);
});

test('哨兵集合：官方值与历史值都视为未配置', () => {
  assert.ok(PLACEHOLDER_KEYS.includes('DFSC_INDEPENDENT_PLUGIN'));
  assert.ok(PLACEHOLDER_KEYS.includes('stepaudio-managed-provider-context'));
  assert.equal(new Set(PLACEHOLDER_KEYS).size, PLACEHOLDER_KEYS.length, '无重复值');
});

test('本地仓库布局：非托管，env 直填仍生效', async () => {
  const config = await loadConfig({ STEP_API_KEY: 'dev-key' }, { pluginRoot: PLUGIN_ROOT });
  assert.equal(config.managed, false);
  assert.equal(config.apiKey, 'dev-key');
  assert.ok(config.reader === undefined, '非托管不构造读取器');
});
