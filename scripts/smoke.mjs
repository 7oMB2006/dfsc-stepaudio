#!/usr/bin/env node
/**
 * stdio 冒烟测试：以假 key 启动 MCP server，走 initialize → tools/list → 两个错误路径，
 * 验证三个工具已注册且参数校验/未知工具错误符合 MCP 规范。不访问真实 API。
 * 运行：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.mjs');

if (!existsSync(entry)) {
  process.stderr.write(`缺少分发产物 ${entry}；请先运行 npm run build\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: { ...process.env, STEP_API_KEY: 'smoke-fake-key', STEPAUDIO_OUTPUT_DIR: path.join(root, 'output') },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});

let buffer = '';
const responses = new Map();
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

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'text_to_speech', arguments: { text: '', voice: 'v' } },
});
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });

const failures = [];
const waitFor = async (id, timeoutMs = 15000) => {
  const started = Date.now();
  while (!responses.has(id) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return responses.get(id);
};

const check = (label, condition) => {
  if (condition) {
    console.log(`✔ ${label}`);
  } else {
    failures.push(label);
    console.log(`✖ ${label}`);
  }
};

const init = await waitFor(1);
check('initialize 返回 serverInfo.name=dfsc-stepaudio', init?.result?.serverInfo?.name === 'dfsc-stepaudio');

const list = await waitFor(2);
const tools = list?.result?.tools ?? [];
const names = tools.map((tool) => tool.name).sort();
check(
  'tools/list 注册 text_to_speech / list_voices / clone_voice',
  JSON.stringify(names) === JSON.stringify(['clone_voice', 'list_voices', 'text_to_speech']),
);
check(
  '每个工具都带 description 与 inputSchema',
  tools.length === 3 && tools.every((tool) => typeof tool.description === 'string' && tool.inputSchema?.type === 'object'),
);

const emptyText = await waitFor(3);
check(
  'text_to_speech 空文本返回 isError 且提示明确',
  emptyText?.result?.isError === true && String(emptyText.result.content?.[0]?.text).includes('text 不能为空'),
);

const unknown = await waitFor(4);
check(
  '未知工具返回 isError',
  unknown?.result?.isError === true && String(unknown.result.content?.[0]?.text).includes('未知工具'),
);

child.kill();

if (failures.length > 0) {
  console.error(`\n冒烟测试失败 ${failures.length} 项`);
  if (stderr) console.error(`--- server stderr ---\n${stderr}`);
  process.exit(1);
}
console.log('\n冒烟测试全部通过');
