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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { StepAudioClient } from './client.js';
import { McpToolError } from './lib/errors.js';import * as textToSpeech from './tools/text-to-speech.js';
import * as listVoices from './tools/list-voices.js';
import * as cloneVoice from './tools/clone-voice.js';
import { createHostClient, HostClientError } from './lib/host-client/client.mjs';

const TOOLS = [textToSpeech, listVoices, cloneVoice];
const SERVER_INFO = { name: 'dfsc-stepaudio', version: '0.3.1' };
/** 与 dfsc.host.json 的 consumer 及 step.plugin.json 的 mcpServers 键一致。 */
const PLUGIN_ID = 'dfsc-stepaudio';
const HOST_CONSUMER = 'stepaudio';
/** 插件包根：打包后位于 <package>/dist/index.js，上一级即包根（与 config.js 同源）。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLLOW_ONLY_NOTICE = '当前为宿主跟随模式：仅 text_to_speech 可用（broker model.tts，首次合成需宿主授权）；'
  + 'list_voices / clone_voice 需要独立模式的 API Key 配置。';
const NO_MODEL_SOURCE_NOTICE = '当前宿主未给 text_to_speech 分配模型来源。请在插件中心为语音合成选择 Step Plan、开放平台 API 或独立配置后重启会话。';

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
  let contextError = null;
  try {
    host = createHostClient({ pluginId: PLUGIN_ID, consumer: HOST_CONSUMER });
  } catch (error) {
    const code = error instanceof HostClientError ? error.code : 'UNKNOWN';
    if (code === 'HOST_UNAVAILABLE') {
      // 上下文缺失（非宿主启动，或宿主发布验收的最小环境）：按独立模式运行
      log('未检测到宿主启动上下文：按独立模式运行');
      host = null;
    } else {
      // 上下文存在但无效（过期/损坏/版本不符）：不静默回退独立模式——
      // 那会换用另一套账户与计费渠道，违反"两分支失败均不静默互切"的承诺
      log(`宿主启动上下文无效（${code}）：拒绝工具调用，待重启会话`);
      contextError = `宿主启动上下文无效（${code}）。请重启使用本插件的会话；`
        + '不要改用独立配置绕过（那会使用另一套账户与计费渠道）。';
      host = null;
    }
  }
  const follow = host !== null && host.mode === 'follow';
  // independentTools 让宿主把“插件自己的工具”分配给独立配置，即使独立能力集合为空。
  // 旧上下文没有该字段，继续沿用整套 follow/independent 行为。
  const independentTools = host !== null && Array.isArray(host.independentCapabilities);
  const independentTts = independentTools && host.independentCapabilities.includes('model.tts');
  const brokerTts = follow && !independentTts;
  const independentToolsAllowed = !follow || independentTools;
  const independentTtsAllowed = (!follow && !independentTools) || independentTts;
  const needsIndependentConfig = independentToolsAllowed || independentTtsAllowed;
  process.on('exit', () => { host?.close(); });

  // 配置在启动时加载；失败不阻断握手，错误在 tools/call 时返回，便于用户看到可操作的提示
  let config = null;
  let client = null;
  let configError = null;
  if (needsIndependentConfig) {
    try {
      // loadConfig 在托管布局下已调用 reader.current() 落定首个 revision（stamp），
      // 不在此处重复调用——整包指纹是秒级开销，启动路径只应有一次
      config = await loadConfig(process.env);
      // 独立工具或独立 TTS：启动读到的配置 revision 必须与宿主签发启动上下文时的
      // configurationRevision 一致。不一致说明上下文签发后配置被改过（换了 Key/端点），
      // 旧会话继续运行会静默改用新账户——拒绝并要求重启会话。
      if (host !== null && host.configurationRevision !== null
        && typeof config.revision === 'string' && config.revision !== host.configurationRevision) {
        log(`配置 revision 与启动上下文不一致：config=${config.revision.slice(0, 8)}`
          + ` context=${host.configurationRevision.slice(0, 8)}`);
        contextError = '宿主启动上下文与当前插件配置不一致（上下文签发后配置已被修改）。'
          + '请重启使用本插件的会话；不要继续使用旧会话（那会静默改用新账户与计费渠道）。';
        config = null;
        client = null;
      } else {
        client = new StepAudioClient(config);
      }
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
      log(`独立配置未就绪：${configError}`);
    }
  }
  if (brokerTts) log('宿主 Broker 已分配语音合成：text_to_speech 走 broker（首次合成等待宿主授权）');

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      inputSchema: tool.definition.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // 宿主启动上下文存在但无效：拒绝一切调用，不回退独立模式（避免更换账户与计费渠道）
    if (contextError) return errorResult(contextError);
    const name = request.params.name;
    const tool = TOOLS.find((candidate) => candidate.definition.name === name);
    if (!tool) return errorResult(`未知工具：${name}`);
    const isTts = tool.definition.name === textToSpeech.definition.name;
    const useBroker = isTts && brokerTts;
    const useIndependent = isTts ? independentTtsAllowed : independentToolsAllowed;
    if (!useBroker && !useIndependent) {
      return errorResult(isTts ? NO_MODEL_SOURCE_NOTICE : FOLLOW_ONLY_NOTICE);
    }
    if (useIndependent && configError) return errorResult(`配置错误：${configError}`);
    if (useIndependent && config?.managed) {
      // 独立工具/独立 TTS 每次调用前复审：revision 变化或读取失败都只让本次调用失败，服务不退出
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
      return await tool.handler(request.params.arguments ?? {}, {
        client, config, host, follow: useBroker, pluginRoot: PLUGIN_ROOT,
      });
    } catch (error) {
      const code = error instanceof McpToolError ? `（${error.code}）` : '';
      const message = error instanceof Error ? error.message : String(error);
      log(`工具 ${name} 执行失败${code}：${message}`);
      return errorResult(`错误${code}：${message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (contextError) {
    log('MCP 服务已启动，但宿主启动上下文/配置绑定无效；tools/call 将拒绝并提示重启会话');
  } else if (brokerTts && independentTools) {
    log('MCP 服务已启动（语音合成走 Broker；插件自有工具走独立配置）');
  } else if (brokerTts) {
    log('MCP 服务已启动（宿主 Broker 模式：text_to_speech 走 broker）');
  } else if (independentTtsAllowed && independentTools) {
    log('MCP 服务已启动（语音合成与插件自有工具走独立配置）');
  } else if (independentToolsAllowed) {
    log('MCP 服务已启动（插件自有工具走独立配置；未分配 Broker 模型）');
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
