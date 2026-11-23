import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagedLayout } from './helpers/managed-layout.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(PLUGIN_ROOT, 'dist', 'index.js');
if (!existsSync(ENTRY)) {
  throw new Error(`缺少分发产物 ${ENTRY}；请先运行 npm run build（npm test 会自动构建）`);
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
};

/** 假音频字节：broker 只保证 base64 规范，插件负责落盘，内容无需是合法 mp3。 */
const FIXTURE_AUDIO = Buffer.from('dfsc-follow-mode-fixture-audio-bytes');

/**
 * 离线 broker：实现 /v1/context、/v1/invoke、/v1/cancel 三个路由，
 * 校验 bearer 与请求形状，按 scenarios 返回结果。不使用真实账户或网络。
 */
async function startBroker(scenarios = {}) {
  const calls = { context: 0, invoke: 0, cancel: 0, invalidAuth: 0 };
  const token = randomBytes(32).toString('base64url'); // parseLaunch 要求恰好 43 字符
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const route = request.url?.replace(/^\/v1\//u, '') ?? '';
      if (request.headers.authorization !== `Bearer ${token}`) calls.invalidAuth += 1;
      const send = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (route === 'context') {
        calls.context += 1;
        const capability = scenarios.capability ?? {
          id: 'model.tts', available: true, model: 'stepaudio-2.5-tts', channel: 'plan', region: 'cn',
        };
        send(200, { version: 1, revision: createHash('sha256').update('ctx').digest('hex'), capabilities: [capability] });
      } else if (route === 'invoke') {
        calls.invoke += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (scenarios.deny) {
          send(403, { version: 1, error: { code: 'DENIED' } });
          return;
        }
        send(200, {
          version: 1,
          requestId: body.requestId,
          result: { type: 'audio', mimeType: 'audio/mpeg', data: FIXTURE_AUDIO.toString('base64') },
        });
      } else if (route === 'cancel') {
        calls.cancel += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        send(200, { version: 1, requestId: body.requestId, cancelled: true });
      } else {
        send(404, { version: 1, error: { code: 'INVALID_REQUEST' } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stop = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return { calls, token, origin: `http://127.0.0.1:${server.address().port}`, stop };
}

/** 构造 follow 模式的 DFSC_LAUNCH_CONTEXT（字段形状见 host-client/protocol.mjs 的 parseLaunch）。 */
function launchContext(origin, token, dataDirectory, extra = {}) {
  return JSON.stringify({
    version: 'dfsc-launch-v1',
    mode: 'follow',
    pluginId: 'dfsc-stepaudio',
    consumer: 'stepaudio',
    instance: randomUUID(),
    fingerprint: createHash('sha256').update('fp').digest('hex'),
    declarationHash: createHash('sha256').update('dh').digest('hex'),
    revision: createHash('sha256').update('rv').digest('hex'),
    configurationRevision: null,
    launchId: randomUUID(),
    runtimeId: randomUUID(),
    sessionId: 'broker-test-session',
    accountRevision: createHash('sha256').update('ar').digest('hex'),
    capabilities: ['model.tts'],
    models: { 'model.tts': 'stepaudio-2.5-tts' },
    dataDirectory,
    broker: { origin, token, expiresAt: Date.now() + 30 * 60 * 1000 },
    ...extra,
  });
}

/** 启动服务并按序发送 JSON-RPC 消息，返回响应表与 stderr。 */
async function runServer(extraEnv, messages, options = {}) {
  const child = spawn(process.execPath, [options.entry ?? ENTRY], {
    cwd: options.cwd ?? PLUGIN_ROOT,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.set(message.id, message);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  for (const message of messages) send(message);
  const waitFor = async (id, timeoutMs = 20000) => {
    const started = Date.now();
    while (!responses.has(id) && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return responses.get(id);
  };
  return {
    child, responses, waitFor, getStderr: () => stderr, send,
    close: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); }),
  };
}

/** 独立配置使用的本地 API fixture：覆盖音色列表与复刻，不访问外网。 */
async function startIndependentApi() {
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      calls.push([request.method, path]);
      const send = (status, payload, contentType = 'application/json') => {
        response.writeHead(status, { 'content-type': contentType });
        response.end(contentType === 'application/json' ? JSON.stringify(payload) : payload);
      };
      if (request.method === 'GET' && path.startsWith('/v1/audio/system_voices')) {
        send(200, { voices: ['fixture-voice'], 'voices-details': { 'fixture-voice': { 'voice-name': 'Fixture' } } });
      } else if (request.method === 'GET' && path.startsWith('/v1/audio/voices')) {
        send(200, { data: [{ id: 'voice-fixture', file_id: 'file-fixture', created_at: 1 }] });
      } else if (request.method === 'POST' && path === '/v1/audio/voices') {
        send(200, { id: 'voice-created', duplicated: false });
      } else if (request.method === 'POST' && path === '/v1/audio/speech') {
        send(200, Buffer.from('INDEPENDENT-AUDIO'), 'audio/mpeg');
      } else {
        send(404, { error: { message: 'not found' } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

const HANDSHAKE = (extraCalls) => [
  INITIALIZE,
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ...extraCalls,
];

async function withFollowServer(scenarios, extraCalls, fn) {
  const broker = await startBroker(scenarios);
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-broker-data-'));
  try {
    const server = await runServer(
      { DFSC_LAUNCH_CONTEXT: launchContext(broker.origin, broker.token, dataDirectory) },
      HANDSHAKE(extraCalls),
    );
    try {
      await fn({ server, broker, dataDirectory });
    } finally {
      await server.close();
    }
  } finally {
    await broker.stop();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
}

test('follow 模式合成走 broker：音频落盘宿主数据目录并回报模式信息', async () => {
  await withFollowServer({}, [
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: '智能阶跃，十倍每一个人的可能', voice: 'voice-tone-UJipnCO55M' } } },
  ], async ({ server, broker, dataDirectory }) => {
    const init = await server.waitFor(1);
    assert.equal(init.result.serverInfo.name, 'dfsc-stepaudio');
    const call = await server.waitFor(3);
    assert.notEqual(call.result.isError, true, call.result?.content?.[0]?.text);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.mode, 'follow');
    assert.equal(payload.model, 'stepaudio-2.5-tts');
    assert.equal(payload.channel, 'plan');
    assert.equal(payload.region, 'cn');
    assert.equal(payload.response_format, 'mp3');
    assert.equal(payload.mime_type, 'audio/mpeg');
    assert.equal(payload.bytes, FIXTURE_AUDIO.length);
    assert.ok(payload.file.startsWith(path.resolve(dataDirectory)), `文件应落在宿主数据目录：${payload.file}`);
    assert.deepEqual(await fs.readFile(payload.file), FIXTURE_AUDIO);
    assert.equal(broker.calls.context, 1);
    assert.equal(broker.calls.invoke, 1);
    assert.equal(broker.calls.invalidAuth, 0);
    assert.ok(!server.getStderr().includes(broker.token), 'stderr 不得泄漏 broker token');
  });
});

test('follow 模式挡住 list_voices / clone_voice 与不支持的参数', async () => {
  await withFollowServer({}, [
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_voices', arguments: { scope: 'cloned' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clone_voice', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'x', voice: 'v', response_format: 'flac' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'x' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'ok', voice: 'v', instruction: '温柔一点', speed: 1.2 } } },
  ], async ({ server, broker }) => {
    const voices = await server.waitFor(3);
    assert.equal(voices.result.isError, true);
    assert.match(voices.result.content[0].text, /list_voices \/ clone_voice 需要独立模式/);
    const clone = await server.waitFor(4);
    assert.equal(clone.result.isError, true);
    const flac = await server.waitFor(5);
    assert.equal(flac.result.isError, true);
    assert.match(flac.result.content[0].text, /仅支持 mp3\/wav\/pcm/);
    const noVoice = await server.waitFor(6);
    assert.equal(noVoice.result.isError, true);
    assert.match(noVoice.result.content[0].text, /请按次指定 voice/);
    const ignored = await server.waitFor(7);
    assert.notEqual(ignored.result.isError, true, ignored.result?.content?.[0]?.text);
    const payload = JSON.parse(ignored.result.content[0].text);
    assert.deepEqual(payload.follow_ignored, ['instruction', 'speed']);
    // 被挡住的调用不产生 broker 流量；只有最后一次成功合成到了 invoke
    assert.equal(broker.calls.invoke, 1);
  });
});

test('follow 模式宿主拒绝：明确报错且不反复请求', async () => {
  await withFollowServer({ deny: true }, [
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'hello', voice: 'v' } } },
  ], async ({ server, broker }) => {
    const call = await server.waitFor(3);
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /宿主授权被拒绝（DENIED）/);
    assert.equal(broker.calls.invoke, 1);
    assert.equal(broker.calls.cancel, 0);
  });
});

test('follow 模式能力不可用：按宿主原因报错，不回退独立链路', async () => {
  await withFollowServer(
    { capability: { id: 'model.tts', available: false, reason: 'AUTHORIZATION_REQUIRED' } },
    [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'hello', voice: 'v' } } },
    ],
    async ({ server, broker }) => {
      const call = await server.waitFor(3);
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /需要宿主授权后才能合成（AUTHORIZATION_REQUIRED）/);
      assert.equal(broker.calls.invoke, 0);
    },
  );
});

test('follow 模式过期租约：STALE_CONTEXT 明确报错且零 broker 请求', async () => {
  const broker = await startBroker({});
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-broker-data-'));
  // 短租约：握手后即过期，验证不会自动续约或重发
  const context = launchContext(broker.origin, broker.token, dataDirectory);
  const parsed = JSON.parse(context);
  parsed.broker.expiresAt = Date.now() + 400;
  const server = await runServer({ DFSC_LAUNCH_CONTEXT: JSON.stringify(parsed) }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]);
  try {
    // 等租约过期后再发调用：验证过期后明确报错，而不是自动续约或重发
    await new Promise((resolve) => setTimeout(resolve, 1200));
    server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'hello', voice: 'v' } } });
    const call = await server.waitFor(2);
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /宿主上下文已失效，请重启相关会话（STALE_CONTEXT）/);
    assert.equal(broker.calls.context, 0);
    assert.equal(broker.calls.invoke, 0);
  } finally {
    await server.close();
    await broker.stop();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test('启动上下文存在但无效：拒绝调用且不静默回退独立模式', async () => {
  // Codex 审查回归：宿主注入了上下文但它损坏/过期时，不得改用独立配置的账户与计费渠道
  const server = await runServer({ DFSC_LAUNCH_CONTEXT: '{"version":"dfsc-launch-v1","mode":"fol' }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'x', voice: 'v' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_voices', arguments: { scope: 'official' } } },
  ]);
  try {
    const init = await server.waitFor(1);
    assert.equal(init.result.serverInfo.name, 'dfsc-stepaudio');
    const list = await server.waitFor(2);
    assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ['clone_voice', 'list_voices', 'text_to_speech']);
    for (const id of [3, 4]) {
      const call = await server.waitFor(id);
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /宿主启动上下文无效/);
      assert.doesNotMatch(call.result.content[0].text, /配置错误|API Key/);
    }
    assert.match(server.getStderr(), /宿主启动上下文无效/);
  } finally {
    await server.close();
  }
});

test('independent 启动上下文与配置 revision 不匹配：拒绝调用（Codex 审查回归）', async () => {
  const layout = await createManagedLayout({
    values: { mode: 'openapi', base_url: 'https://api.test/v1', api_key: 'k', model: 'stepaudio-2.5-tts' },
    secrets: { api_key: 'k' },
    packageFiles: ['package.json', 'step.plugin.json', 'dfsc.settings.json', 'dist/index.js'],
  });
  const contextRevision = 'b'.repeat(64);
  const h = () => createHash('sha256').update('x').digest('hex');
  const launch = {
    version: 'dfsc-launch-v1', mode: 'independent', pluginId: 'dfsc-stepaudio', consumer: 'stepaudio',
    instance: randomUUID(), fingerprint: h(), declarationHash: h(), revision: h(),
    configurationRevision: contextRevision, launchId: randomUUID(), runtimeId: randomUUID(),
    sessionId: 'revision-mismatch', accountRevision: h(), capabilities: ['model.tts'],
    models: {}, dataDirectory: path.join(layout.root, 'data'),
  };
  const server = await runServer({ DFSC_LAUNCH_CONTEXT: JSON.stringify(launch) }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'x', voice: 'v' } } },
  ], { entry: path.join(layout.pkg, 'dist', 'index.js'), cwd: layout.root });
  try {
    const init = await server.waitFor(1, 5000);
    assert.ok(init, 'initialize 超时；stderr=' + server.getStderr());
    const call = await server.waitFor(2, 5000);
    assert.ok(call, 'tools/call 超时；stderr=' + server.getStderr());
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /宿主启动上下文与当前插件配置不一致/);
    assert.doesNotMatch(call.result.content[0].text, /配置错误/);
  } finally {
    await server.close();
    await fs.rm(layout.root, { recursive: true, force: true });
  }
});

test('independentTools 混合来源：合成走 Broker，列音色/复刻走独立配置', async () => {
  const broker = await startBroker({});
  const api = await startIndependentApi();
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-broker-data-'));
  const context = launchContext(broker.origin, broker.token, dataDirectory, {
    configurationRevision: 'c'.repeat(64),
    independentCapabilities: [],
  });
  const server = await runServer({
    DFSC_LAUNCH_CONTEXT: context,
    STEP_API_KEY: 'independent-fixture-key',
    STEPAUDIO_BASE_URL: `${api.origin}/v1`,
  }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'broker audio', voice: 'v' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_voices', arguments: { scope: 'official' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clone_voice', arguments: { file_id: 'file-fixture' } } },
  ]);
  try {
    await server.waitFor(1);
    const tts = await server.waitFor(2);
    assert.notEqual(tts.result.isError, true, tts.result?.content?.[0]?.text);
    assert.equal(JSON.parse(tts.result.content[0].text).mode, 'follow');
    const voices = await server.waitFor(3);
    assert.notEqual(voices.result.isError, true, voices.result?.content?.[0]?.text);
    assert.equal(JSON.parse(voices.result.content[0].text).official.source, 'api');
    const clone = await server.waitFor(4);
    assert.notEqual(clone.result.isError, true, clone.result?.content?.[0]?.text);
    assert.equal(JSON.parse(clone.result.content[0].text).voice_id, 'voice-created');
    assert.equal(broker.calls.invoke, 1);
    assert.deepEqual(api.calls.map(([method]) => method), ['GET', 'POST']);
  } finally {
    await server.close();
    await broker.stop();
    await api.stop();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test('independentTools 未分配模型行：TTS 拒绝，独立工具仍可用', async () => {
  const api = await startIndependentApi();
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-broker-data-'));
  const context = launchContext('http://127.0.0.1:1', 'unused', dataDirectory, {
    mode: 'independent',
    capabilities: [],
    models: {},
    configurationRevision: 'c'.repeat(64),
    independentCapabilities: [],
    broker: undefined,
  });
  const server = await runServer({
    DFSC_LAUNCH_CONTEXT: context,
    STEP_API_KEY: 'independent-fixture-key',
    STEPAUDIO_BASE_URL: `${api.origin}/v1`,
  }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'no route', voice: 'v' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_voices', arguments: { scope: 'official' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clone_voice', arguments: { file_id: 'file-fixture' } } },
  ]);
  try {
    await server.waitFor(1);
    const tts = await server.waitFor(2);
    assert.equal(tts.result.isError, true);
    assert.match(tts.result.content[0].text, /未给 text_to_speech 分配模型来源/);
    const voices = await server.waitFor(3);
    assert.notEqual(voices.result.isError, true, voices.result?.content?.[0]?.text);
    const clone = await server.waitFor(4);
    assert.notEqual(clone.result.isError, true, clone.result?.content?.[0]?.text);
    assert.equal(JSON.parse(clone.result.content[0].text).voice_id, 'voice-created');
    assert.ok(!api.calls.some(([method, path]) => method === 'POST' && path === '/v1/audio/speech'));
  } finally {
    await server.close();
    await api.stop();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test('independentTools 模型行分配独立 API：TTS 直连且不经过 Broker', async () => {
  const api = await startIndependentApi();
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-broker-data-'));
  const context = launchContext('http://127.0.0.1:1', 'unused', dataDirectory, {
    mode: 'independent',
    capabilities: ['model.tts'],
    models: {},
    configurationRevision: 'c'.repeat(64),
    independentCapabilities: ['model.tts'],
    broker: undefined,
  });
  const server = await runServer({
    DFSC_LAUNCH_CONTEXT: context,
    STEP_API_KEY: 'independent-fixture-key',
    STEPAUDIO_BASE_URL: `${api.origin}/v1`,
  }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'independent audio', voice: 'v' } } },
  ]);
  try {
    await server.waitFor(1);
    const tts = await server.waitFor(2);
    assert.notEqual(tts.result.isError, true, tts.result?.content?.[0]?.text);
    const payload = JSON.parse(tts.result.content[0].text);
    assert.equal(payload.kind, 'file');
    assert.equal(await fs.readFile(payload.file, 'utf8'), 'INDEPENDENT-AUDIO');
    assert.deepEqual(api.calls, [['POST', '/v1/audio/speech']]);
  } finally {
    await server.close();
    await api.stop();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test('无启动上下文时按独立模式运行（宿主发布验收路径）', async () => {
  const server = await runServer({}, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: 'x', voice: 'v' } } },
  ]);
  try {
    const init = await server.waitFor(1);
    assert.equal(init.result.serverInfo.name, 'dfsc-stepaudio');
    const list = await server.waitFor(2);
    assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ['clone_voice', 'list_voices', 'text_to_speech']);
    const call = await server.waitFor(3);
    // 无配置时报配置错误（独立模式语义不变），而不是跟随模式提示
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /配置/);
    assert.match(server.getStderr(), /未检测到宿主启动上下文/);
  } finally {
    await server.close();
  }
});
