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
import { McpToolError } from './lib/errors.js';import * as textToSpeech from './tools/text-to-speech.js';
import * as listVoices from './tools/list-voices.js';
import * as cloneVoice from './tools/clone-voice.js';
import { createHostClient, HostClientError } from './lib/host-client/client.mjs';

const TOOLS = [textToSpeech, listVoices, cloneVoice];
const SERVER_INFO = { name: 'dfsc-stepaudio', version: '0.3.0' };
/** 与 dfsc.host.json 的 consumer 及 step.plugin.json 的 mcpServers 键一致。 */
const PLUGIN_ID = 'dfsc-stepaudio';
const HOST_CONSUMER = 'stepaudio';
const FOLLOW_ONLY_NOTICE = '当前为宿主跟随模式：仅 text_to_speech 可用（broker model.tts，首次合成需宿主授权）；'
  + 'list_voices / clone_voice 需要独立模式的 API Key 配置。';

function log(message) {
  // stdio 传输下 stdout 是 JSON-RPC 通道，日志只能走 stderr
  process.stderr.write(`[dfsc-stepaudio] ${message}\n`);
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function main() {
  // 宿主启动上下文（DFSC_LAUNCH_CONTEXT）：follow = 合成走 broker（零 Key），
  // independent = 走插件自己的配置。宿主发布验收等场景不带上下文，
  // 此时降级为纯独立模式，服务照常握手（list_voices/合成均可用）。
  let host = null;
  try {
    host = createHostClient({ pluginId: PLUGIN_ID, consumer: HOST_CONSUMER });
  } catch (error) {
    const code = error instanceof HostClientError ? error.code : 'UNKNOWN';
    log(`无可用宿主启动上下文（${code}）：按独立模式运行`);
    host = null;
  }
  const follow = host !== null && host.mode === 'follow';
  process.on('exit', () => { host?.close(); });

  // 配置在启动时加载；失败不阻断握手，错误在 tools/call 时返回，便于用户看到可操作的提示
  let config = null;
  let client = null;
  let configError = null;
  if (follow) {
    // 跟随模式的 launch context 里 configurationRevision 为 null：不读独立配置、
    // 不需要 API Key。broker 只提供合成，列音色/复刻没有入口，用固定提示挡住其余工具。
    configError = FOLLOW_ONLY_NOTICE;
    log('宿主跟随模式：text_to_speech 走 broker（首次合成等待宿主授权）');
  } else {
    try {
      // loadConfig 在托管布局下已调用 reader.current() 落定首个 revision（stamp），
      // 不在此处重复调用——整包指纹是秒级开销，启动路径只应有一次
      config = await loadConfig(process.env);
      client = new StepAudioClient(config);
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
      log(`配置未就绪：${configError}`);
    }
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
    const name = request.params.name;
    const tool = TOOLS.find((candidate) => candidate.definition.name === name);
    // 跟随模式下 broker 只覆盖合成；其余工具仍需独立配置，由固定提示挡住
    const followAllowed = follow && tool?.definition.name === textToSpeech.definition.name;
    if (configError && !followAllowed) return errorResult(`配置错误：${configError}`);
    if (!tool) return errorResult(`未知工具：${name}`);
    if (config?.managed && !follow) {
      // 每次调用前复审：revision 变化或读取失败都只让本次调用失败，服务不退出
      try {
        const snapshot = await config.reader.current();
        if (snapshot.revision !== config.revision) {
          return errorResult('配置已在插件中心变更，请重启服务后重试。');
        }
      } catch {
        return errorResult('配置不可用或已变更，请在插件中心重新保存配置并重启服务。');
      }
    }
    try {
      return await tool.handler(request.params.arguments ?? {}, { client, config, host, follow: followAllowed });
    } catch (error) {
      const code = error instanceof McpToolError ? `（${error.code}）` : '';
      const message = error instanceof Error ? error.message : String(error);
      log(`工具 ${name} 执行失败${code}：${message}`);
      return errorResult(`错误${code}：${message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (follow) {
    log('MCP 服务已启动（宿主跟随模式：text_to_speech 走 broker，其余工具需独立配置）');
  } else if (configError) {
    log('MCP 服务已启动，但配置未就绪；tools/call 将返回配置错误与配置方法');
  } else {
    log(`MCP 服务已启动（mode=${config.mode}, base=${config.baseUrl}, model=${config.model}, output=${config.outputDir}）`);
  }
}

main().catch((error) => {
  log(`服务异常退出：${error?.stack ?? error}`);
  process.exit(1);
});
