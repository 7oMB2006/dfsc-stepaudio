#!/usr/bin/env node
/**
 * 真机验收驱动：在本机构建的 DFSC 宿主上验收 dfsc-StepAudio 0.2.0。
 *
 * 流程（对应 docs/acceptance-runbook.md）：
 *   1. 隔离 profile 启动宿主（win-unpacked 便携版）
 *   2. 添加本仓库为本地市场源 → 安装插件
 *   3. 读取配置 schema（核对 8 字段 / consumer.server）
 *   4. 保存配置（base_url 指向本地 HTTP fixture，secret 用假 Key）
 *   5. 用真实宿主布局直接 spawn dist/index.mjs，验证 reader 读到宿主设置、
 *     合成请求带正确 Bearer 到达 fixture
 *   6. 再次保存（新 revision）→ 验证下一次调用 fail-closed
 *   7. 卸载插件，验证移除
 *
 * 用法：node scripts/acceptance-host.mjs
 * 环境变量：HOST_DIR（宿主 Desktop 目录）、PLUGIN_DIR（本仓库）、KEEP（保留产物）
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DIR = process.env.HOST_DIR ?? 'D:/StepFun/dfsc-host-build/desktop-for-step-code/Desktop';
const PLUGIN_DIR = process.env.PLUGIN_DIR ?? PLUGIN_ROOT;
const EXE = path.join(HOST_DIR, 'release', 'win-unpacked', 'Desktop for Step Code.exe');

const hostRequire = createRequire(path.join(HOST_DIR, 'package.json'));
const { _electron: electron } = hostRequire('playwright');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// ---- 本地 TTS API fixture ----
const requests = [];
const fixture = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from('ACCEPTANCE-AUDIO'));
  });
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixturePort = fixture.address().port;

// ---- 隔离 profile ----
const profile = await mkdtemp(path.join(os.tmpdir(), 'dfsc-accept-'));
await fs.mkdir(path.join(profile, 'step-runtime'), { recursive: true });
await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ language: 'zh', theme: 'dark', workspaces: [] }));
await fs.writeFile(
  path.join(profile, 'step-runtime', 'config.toml'),
  'defaultProvider = "fixture"\ndefaultModel = "fixture"\n[telemetry]\nenabled = false\n',
);
const outputDir = await mkdtemp(path.join(os.tmpdir(), 'dfsc-accept-out-'));

let app;
let child;
try {
  // ---- 1. 启动宿主 ----
  app = await electron.launch({
    executablePath: EXE,
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    env: {
      ...process.env,
      DESKTOP_TEST_USER_DATA: profile,
      DESKTOP_TEST_NO_FOCUS: '1',
    },
    timeout: 60000,
  });
  const main = await app.firstWindow();
  main.setDefaultTimeout(30000);
  await main.waitForFunction(() => typeof window.desktop?.updateState === 'function');
  check('宿主启动（隔离 profile）', true);

  const catalog = () => main.evaluate(() => window.desktop.capabilityCatalog());
  const mutate = (input) => main.evaluate((i) => window.desktop.capabilityMutate(i), input);

  // ---- 2. 本地市场源 + 安装 ----
  const added = await mutate({ action: 'marketplace-add', source: pathToFileURL(PLUGIN_DIR).href });
  check('添加本地市场源', !added?.warnings?.length, JSON.stringify(added?.warnings ?? []));
  const afterAdd = await catalog();
  const available = afterAdd.available?.find((item) => item.name === 'dfsc-stepaudio');
  check('市场目录出现 dfsc-stepaudio', Boolean(available), available ? `ref=${available.ref}` : '未找到');
  if (!available) throw new Error('插件未出现在市场目录');

  const installedResult = await mutate({
    action: 'plugin-install',
    ref: available.ref,
    name: available.name,
    marketplace: available.marketplace,
  });
  const afterInstall = await catalog();
  const installed = afterInstall.plugins?.find((plugin) => plugin.id === 'dfsc-stepaudio');
  check('插件安装', Boolean(installed?.package?.provenance === 'recorded'), installed ? `ref=${installed.package.ref}` : '未安装');

  // ---- 3. 配置 schema ----
  const ref = installed.package.ref;
  const current = await main.evaluate((r) => window.desktop.pluginConfiguration({ ref: r }), ref);
  const fields = current.schema.groups.flatMap((group) => group.fields);
  check('配置 schema：8 字段', fields.length === 8, fields.map((f) => f.id).join(','));
  check('consumer.server = stepaudio', current.schema.consumer?.server === 'stepaudio');
  check('api_key 为 secret 且必填', fields.find((f) => f.id === 'api_key')?.type === 'secret'
    && fields.find((f) => f.id === 'api_key')?.required === true);
  check('初始 revision = unconfigured', current.revision === 'unconfigured', current.revision);

  // ---- 4. 保存配置 ----
  const saved = await main.evaluate(
    (input) => window.desktop.pluginSaveConfiguration(input),
    {
      ref,
      revision: 'unconfigured',
      values: {
        mode: 'openapi',
        base_url: `http://127.0.0.1:${fixturePort}/v1`,
        model: 'stepaudio-2.5-tts',
        output_dir: outputDir,
        voice: 'cixingnansheng',
        instruction: '语气温柔，语速偏慢',
        response_format: 'mp3',
      },
      secrets: { api_key: { action: 'replace', value: 'acceptance-fake-key' } },
    },
  );
  check('保存配置', Boolean(saved?.revision) && saved.revision !== 'unconfigured', `revision=${saved?.revision}`);

  // 宿主私有布局落盘
  const installedPkg = path.join(profile, 'step-runtime', 'plugins', 'dfsc-stepaudio');
  const bindingFile = path.join(profile, 'step-runtime', 'desktop-plugins', 'bindings', 'dfsc-stepaudio.json');
  check('宿主写入 binding', await fs.access(bindingFile).then(() => true, () => false));
  check('安装包含 dist/index.mjs', await fs.access(path.join(installedPkg, 'dist', 'index.js')).then(() => true, () => false));

  // ---- 5. 真实布局 + 我们的产物：reader 读宿主设置并合成 ----
  child = spawn(process.execPath, [path.join(installedPkg, 'dist', 'index.js')], {
    cwd: profile,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        const index = buffer.indexOf('\n');
        if (index === -1) return;
        child.stdout.off('data', onData);
        resolve(JSON.parse(buffer.slice(0, index)));
      };
      child.stdout.on('data', onData);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error('rpc timeout')), 20000);
    });
  await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const call = await rpc(2, 'tools/call', { name: 'text_to_speech', arguments: { text: '真机验收合成' } });
  const payload = call.result?.isError ? null : JSON.parse(call.result.content[0].text);
  check('按宿主设置合成成功', Boolean(payload?.kind === 'file'), call.result?.isError ? call.result.content[0].text : payload?.file);
  check('请求带宿主设置的 Key', requests[0]?.auth === 'Bearer acceptance-fake-key', requests[0]?.auth ?? '(无请求)');
  check('请求体用设置的音色/模型', (() => {
    try {
      const body = JSON.parse(requests[0]?.body ?? '{}');
      return body.voice === 'cixingnansheng' && body.model === 'stepaudio-2.5-tts' && body.input === '真机验收合成';
    } catch {
      return false;
    }
  })());
  check('输出落在设置目录', Boolean(payload?.file?.startsWith(outputDir)), payload?.file ?? '');

  // ---- 6. 改设置 → fail-closed ----
  await main.evaluate(
    (input) => window.desktop.pluginSaveConfiguration(input),
    {
      ref,
      revision: saved.revision,
      values: { ...saved.values, model: 'step-tts-2' },
      secrets: { api_key: { action: 'keep' } },
    },
  );
  const call2 = await rpc(3, 'tools/call', { name: 'text_to_speech', arguments: { text: '第二次' } });
  check('配置变更后 fail-closed', call2.result?.isError === true && /配置/.test(call2.result.content[0].text), call2.result?.content?.[0]?.text);
  child.kill();
  child = null;

  // ---- 7. 卸载 ----
  await mutate({ action: 'plugin-remove', id: 'dfsc-stepaudio', ref });
  const afterRemove = await catalog();
  check('卸载后插件消失', !afterRemove.plugins?.some((plugin) => plugin.id === 'dfsc-stepaudio'));

  await app.close();
  app = null;
} finally {
  child?.kill();
  if (app) await app.close().catch(() => {});
  await new Promise((resolve) => fixture.close(resolve));
  if (!process.env.KEEP) {
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`产物保留：profile=${profile} output=${outputDir}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
