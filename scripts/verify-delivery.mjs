#!/usr/bin/env node
/**
 * 最终交付目录验收：不借用源码仓库的 package.json。
 *
 * 用法：node scripts/verify-delivery.mjs <交付目录>
 * 交付目录必须包含 dist/index.mjs，且其祖先目录不能有 package.json。
 * 使用假 DFSC_LAUNCH_CONTEXT 启动，验证 initialize 与 tools/list；不调用任何模型。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delivery = path.resolve(process.argv[2] ?? '');
if (!delivery || process.argv.length !== 3) {
  console.error('用法：node scripts/verify-delivery.mjs <交付目录>');
  process.exit(2);
}

async function assertDeliveryLayout(dir) {
  const relative = path.relative(sourceRoot, dir);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('交付目录不能位于源码仓库内，否则可能借用仓库根 package.json');
  }
  try {
    await fs.access(path.join(dir, 'package.json'));
    throw new Error('交付目录自身不能包含 package.json（用于复现社区安装目录）');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const entry = path.join(delivery, 'dist', 'index.mjs');
await fs.access(entry);
await assertDeliveryLayout(delivery);

let brokerRequests = 0;
const broker = createServer((request, response) => {
  brokerRequests += 1;
  request.resume();
  response.writeHead(500, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ version: 1, error: { code: 'HOST_UNAVAILABLE' } }));
});
await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
const brokerOrigin = `http://127.0.0.1:${broker.address().port}`;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
const launch = {
  version: 'dfsc-launch-v1',
  mode: 'follow',
  pluginId: 'dfsc-stepaudio',
  consumer: 'stepaudio',
  instance: randomUUID(),
  fingerprint: hash(),
  declarationHash: hash(),
  revision: hash(),
  configurationRevision: null,
  launchId: randomUUID(),
  runtimeId: randomUUID(),
  sessionId: 'delivery-verification',
  accountRevision: hash(),
  capabilities: ['model.tts'],
  models: { 'model.tts': 'stepaudio-2.5-tts' },
  dataDirectory: path.join(delivery, 'data'),
  broker: {
    origin: brokerOrigin,
    token: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + 30 * 60 * 1000,
  },
};

const child = spawn(process.execPath, [entry], {
  cwd: delivery,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    DFSC_LAUNCH_CONTEXT: JSON.stringify(launch),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
const responses = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  }
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const waitFor = async (id, timeoutMs = 15000) => {
  const started = Date.now();
  while (!responses.has(id) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return responses.get(id);
};

try {
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'delivery-check', version: '1.0.0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const init = await waitFor(1);
  if (init?.result?.serverInfo?.name !== 'dfsc-stepaudio') {
    throw new Error(`initialize 失败：${JSON.stringify(init ?? {})}\n${stderr}`);
  }
  const list = await waitFor(2);
  const tools = list?.result?.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['clone_voice', 'list_voices', 'text_to_speech'])) {
    throw new Error(`tools/list 不符合预期：${JSON.stringify(names)}\n${stderr}`);
  }
  if (!tools.every((tool) => typeof tool.description === 'string' && tool.inputSchema?.type === 'object')) {
    throw new Error('工具 description/inputSchema 不完整');
  }
  if (brokerRequests !== 0) throw new Error(`握手期间发生了 broker 请求：${brokerRequests}`);
  console.log(JSON.stringify({
    passed: true,
    delivery,
    entry: 'dist/index.mjs',
    packageJsonInDelivery: false,
    sourceRepoAncestor: false,
    serverInfo: init.result.serverInfo,
    tools: names,
    brokerRequests,
    realModelRequests: 0,
  }, null, 2));
} finally {
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise((resolve) => { broker.closeAllConnections(); broker.close(resolve); });
}
