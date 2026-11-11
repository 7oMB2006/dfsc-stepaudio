import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 协议测试启动实际分发产物（自包含打包文件），npm test 的 pretest 会先构建
const ENTRY = path.join(PLUGIN_ROOT, 'dist', 'index.js');
if (!existsSync(ENTRY)) {
  throw new Error(`缺少分发产物 ${ENTRY}；请先运行 npm run build（npm test 会自动构建）`);
}

/** 以最小环境变量启动 server，返回按 id 索引的响应表。 */
async function runServer(extraEnv, messages) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PLUGIN_ROOT,
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
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  for (const message of messages) send(message);

  const waitFor = async (id, timeoutMs = 15000) => {
    const started = Date.now();
    while (!responses.has(id) && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return responses.get(id);
  };

  return { child, responses, waitFor, getStderr: () => stderr };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
};

async function withTempProfile(fn) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-stepaudio-proto-'));
  try {
    await fn(profile);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
}

test('私密配置模式下完成握手并注册三个工具', async () => {
  await withTempProfile(async (profile) => {
    const envFile = path.join(profile, 'provider.env');
    await fs.writeFile(envFile, 'STEP_API_KEY=private-key\n');
    const configPath = path.join(profile, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, mode: 'independent', envFile }));

    const server = await runServer({ STEPAUDIO_CONFIG_PATH: configPath }, [
      INITIALIZE,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'text_to_speech', arguments: { text: '', voice: 'v' } } },
      { jsonrpc: '2.0', id: 4, method: 'ping' },
    ]);
    try {
      const init = await server.waitFor(1);
      assert.equal(init.result.serverInfo.name, 'dfsc-stepaudio');
      assert.equal(init.result.protocolVersion, '2024-11-05');

      const list = await server.waitFor(2);
      assert.deepEqual(
        list.result.tools.map((tool) => tool.name).sort(),
        ['clone_voice', 'list_voices', 'text_to_speech'],
      );

      const call = await server.waitFor(3);
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /text 不能为空/);

      const ping = await server.waitFor(4);
      assert.deepEqual(ping.result, {});
    } finally {
      server.child.kill();
    }
  });
});

test('跟随 DFSC 配置下 tools/call 返回桥接不支持的错误，握手不受影响', async () => {
  await withTempProfile(async (profile) => {
    const envFile = path.join(profile, 'provider.env');
    await fs.writeFile(envFile, 'STEP_API_KEY=x\n');
    const configPath = path.join(profile, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 2, mode: 'dfsc', hostAccess: 'confirm', envFile }),
    );

    const server = await runServer({ STEPAUDIO_CONFIG_PATH: configPath }, [
      INITIALIZE,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_voices', arguments: {} } },
    ]);
    try {
      const init = await server.waitFor(1);
      assert.equal(init.result.serverInfo.name, 'dfsc-stepaudio');
      const call = await server.waitFor(2);
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /桥接/);
    } finally {
      server.child.kill();
    }
  });
});

test('未知方法对请求返回 -32601，未知工具返回 isError', async () => {
  const server = await runServer({ STEP_API_KEY: 'direct-key' }, [
    INITIALIZE,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'resources/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
  ]);
  try {
    const unknownMethod = await server.waitFor(2);
    assert.equal(unknownMethod.error.code, -32601);
    const unknownTool = await server.waitFor(3);
    assert.equal(unknownTool.result.isError, true);
    assert.match(unknownTool.result.content[0].text, /未知工具/);
  } finally {
    server.child.kill();
  }
});
