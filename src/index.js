#!/usr/bin/env node
/**
 * dfsc-StepAudio：阶跃 StepAudio TTS 的 MCP 服务。
 *
 * 开发期使用官方 MCP SDK；分发前经 esbuild 打包为自包含单文件 dist/index.js
 * （见 package.json 的 build 脚本与 README「开发」一节）。市场安装不执行
 * npm install，因此进入 step.plugin.json 的是打包产物，不是本文件。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { StepAudioClient } from './client.js';
import { McpToolError } from './lib/errors.js';
import * as textToSpeech from './tools/text-to-speech.js';
import * as listVoices from './tools/list-voices.js';
import * as cloneVoice from './tools/clone-voice.js';

const TOOLS = [textToSpeech, listVoices, cloneVoice];
const SERVER_INFO = { name: 'dfsc-stepaudio', version: '0.2.0' };

function log(message) {
  // stdio 传输下 stdout 是 JSON-RPC 通道，日志只能走 stderr
  process.stderr.write(`[dfsc-stepaudio] ${message}\n`);
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function main() {
  // 配置在启动时加载；失败不阻断握手，错误在 tools/call 时返回，便于用户看到可操作的提示
  let config = null;
  let client = null;
  let configError = null;
  try {
    config = await loadConfig(process.env);
    client = new StepAudioClient(config);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    log(`配置未就绪：${configError}`);
  }

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      inputSchema: tool.definition.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (configError) return errorResult(`配置错误：${configError}`);
    const name = request.params.name;
    const tool = TOOLS.find((candidate) => candidate.definition.name === name);
    if (!tool) return errorResult(`未知工具：${name}`);
    try {
      return await tool.handler(request.params.arguments ?? {}, { client, config });
    } catch (error) {
      const code = error instanceof McpToolError ? `（${error.code}）` : '';
      const message = error instanceof Error ? error.message : String(error);
      log(`工具 ${name} 执行失败${code}：${message}`);
      return errorResult(`错误${code}：${message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (configError) {
    log('MCP 服务已启动，但配置未就绪；tools/call 将返回配置错误与配置方法');
  } else {
    log(`MCP 服务已启动（mode=${config.mode}, base=${config.baseUrl}, model=${config.model}, output=${config.outputDir}）`);
  }
}

main().catch((error) => {
  log(`服务异常退出：${error?.stack ?? error}`);
  process.exit(1);
});
