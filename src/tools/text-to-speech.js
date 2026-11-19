import { stat } from 'node:fs/promises';
import { resolveOutputPath, writeBuffer } from '../lib/fs-utils.js';
import { McpToolError } from '../lib/errors.js';
import { HostClientError, newRequestId } from '../lib/host-client/client.mjs';
import { cleanParams, textResult } from './shared.js';

const RESPONSE_FORMATS = ['mp3', 'wav', 'flac', 'opus', 'pcm'];
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 48000];
/** instruction 长度上限（按模型，来自平台文档）。 */
const INSTRUCTION_LIMITS = {
  'stepaudio-2.5-tts': 200,
  'stepaudio-3-tts': 500,
};

/** 跟随模式（broker）支持的格式及 MIME：broker 只收 mp3/wav/pcm。 */
const FOLLOW_FORMATS = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm' };
/** broker 请求只接受 text/voice/format，以下参数在跟随模式下被忽略并在结果中声明。 */
const FOLLOW_IGNORED = ['model', 'instruction', 'speed', 'volume', 'sample_rate', 'return_url'];
/** 常见宿主错误码的可读说明。 */
const HOST_ERROR_HINTS = {
  DENIED: '宿主授权被拒绝',
  STALE_CONTEXT: '宿主上下文已失效，请重启相关会话',
  CAPABILITY_UNAVAILABLE: '宿主 TTS 能力当前不可用',
  AUTHORIZATION_REQUIRED: '需要宿主授权后才能合成',
  BUSY: '宿主任务已满，请稍后重试',
  TIMEOUT: '宿主任务超时',
  CANCELLED: '合成已取消',
  TOO_LARGE: '音频超出宿主大小上限',
  PROVIDER_FAILED: '上游合成失败',
};

function hostError(error) {
  const code = error instanceof HostClientError ? error.code : 'HOST_UNAVAILABLE';
  const hint = HOST_ERROR_HINTS[code];
  return new McpToolError(hint ? `宿主 TTS 调用失败：${hint}（${code}）` : `宿主 TTS 调用失败：${code}`, { code });
}

/** 宿主跟随模式：text/voice/format 走 broker，base64 音频自行落盘。 */
async function synthesizeViaHost(args, ctx) {
  const text = String(args.text ?? '');
  if (text.trim() === '') throw new McpToolError('text 不能为空', { code: 'INVALID_ARGS' });
  if (text.length > 1000) {
    throw new McpToolError(`text 超长：${text.length} 字符，上限 1000`, { code: 'INVALID_ARGS' });
  }
  const voice = String(args.voice ?? '').trim();
  if (voice === '') {
    throw new McpToolError('跟随模式下请按次指定 voice（音色 ID；可在独立模式下用 list_voices 查询）', {
      code: 'INVALID_ARGS',
    });
  }
  const format = String(args.response_format ?? 'mp3').toLowerCase();
  if (!Object.hasOwn(FOLLOW_FORMATS, format)) {
    throw new McpToolError(`跟随模式仅支持 mp3/wav/pcm，当前为 ${format}`, { code: 'INVALID_ARGS' });
  }
  const ignored = FOLLOW_IGNORED.filter((key) => args[key] !== undefined);

  const host = ctx.host;
  let context;
  try {
    context = await host.context();
  } catch (error) {
    throw hostError(error);
  }
  const tts = context.capabilities.find((item) => item.id === 'model.tts');
  if (!tts?.available) {
    throw hostError(new HostClientError(tts?.reason ?? 'CAPABILITY_UNAVAILABLE'));
  }
  let result;
  try {
    result = await host.invoke({
      requestId: newRequestId(),
      revision: context.revision,
      capability: 'model.tts',
      input: { text, voice, format },
    });
  } catch (error) {
    throw hostError(error);
  }

  // 二进制音频的播放/命名/落盘由插件负责；不把 base64 当 URL 或已存路径
  const buffer = Buffer.from(result.data, 'base64');
  const filePath = resolveOutputPath(host.dataDirectory, args.output_path, format);
  await writeBuffer(filePath, buffer);
  const { size } = await stat(filePath);

  return textResult({
    kind: 'file',
    file: filePath,
    bytes: size,
    response_format: format,
    mime_type: result.mimeType,
    voice,
    model: tts.model,
    channel: tts.channel,
    region: tts.region,
    mode: 'follow',
    ...(ignored.length > 0 ? { follow_ignored: ignored } : {}),
  });
}

export const definition = {
  name: 'text_to_speech',
  description:
    '把文本合成为语音音频（阶跃 StepAudio TTS）。支持全局语境 instruction 定调、括号内联指令、语速/音量/采样率控制。音频写入文件并返回绝对路径。'
    + '宿主跟随模式下仅使用 text/voice/response_format（mp3/wav/pcm），音频写入宿主数据目录，首次合成需宿主授权。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要合成的文本，最大 1000 字符。括号 () 内内容作为指令处理、不发音。' },
      voice: { type: 'string', description: '音色 ID（官方或已复刻，可用 list_voices 查询）。缺省时使用配置中的默认音色。' },
      model: { type: 'string', description: '模型，如 stepaudio-2.5-tts / stepaudio-3-tts / step-tts-2 / step-tts-mini；缺省用配置值。' },
      instruction: { type: 'string', description: '全局自然语言指导（情绪基调、人设），stepaudio-2.5-tts 上限 200 字符；缺省用配置值。' },
      response_format: { type: 'string', enum: RESPONSE_FORMATS, description: '音频格式，缺省用配置值（默认 mp3）。' },
      speed: { type: 'number', description: '语速 0.5~2，默认 1.0。' },
      volume: { type: 'number', description: '音量 0.1~2.0，默认 1.0。' },
      sample_rate: { type: 'integer', enum: SAMPLE_RATES, description: '采样率，默认 24000。' },
      output_path: { type: 'string', description: '输出文件路径（绝对或相对）；缺省写入插件 output 目录。' },
      return_url: { type: 'boolean', description: 'true 时不落盘，返回上游文件 URL（12 小时有效）与字幕（如有）。' },
    },
    required: ['text'],
  },
};

export async function handler(args, ctx) {
  // 宿主跟随模式下只走 broker（零 Key），不读独立配置、不回退
  if (ctx.follow) return synthesizeViaHost(args, ctx);
  const { client, config } = ctx;
  const text = String(args.text ?? '');
  if (text.trim() === '') throw new McpToolError('text 不能为空', { code: 'INVALID_ARGS' });
  if (text.length > 1000) {
    throw new McpToolError(`text 超长：${text.length} 字符，上限 1000`, { code: 'INVALID_ARGS' });
  }
  // 默认值来自配置（插件中心设置 / env / CLI 私密配置），按次传参优先
  const voice = (String(args.voice ?? '').trim() || config.voice || '').trim();
  if (voice === '') {
    throw new McpToolError('voice 不能为空：请按次指定，或在配置中设置默认音色', { code: 'INVALID_ARGS' });
  }

  const model = args.model ?? config.model;
  const instruction = args.instruction ?? config.instruction;
  if (instruction !== undefined && instruction !== '') {
    const limit = INSTRUCTION_LIMITS[model];
    if (limit !== undefined && instruction.length > limit) {
      throw new McpToolError(`instruction 超长：${instruction.length} 字符，模型 ${model} 上限 ${limit}`, {
        code: 'INVALID_ARGS',
      });
    }
  }

  const responseFormat = (args.response_format ?? config.responseFormat ?? 'mp3').toLowerCase();
  const returnUrl = args.return_url === true;

  const params = cleanParams({
    model,
    voice,
    input: text,
    instruction,
    response_format: responseFormat,
    speed: args.speed,
    volume: args.volume,
    sample_rate: args.sample_rate,
    return_url: returnUrl,
  });

  const result = await client.createSpeech(params);

  if (result.kind === 'url') {
    return textResult({
      kind: 'url',
      url: result.url,
      model,
      voice,
      response_format: responseFormat,
      subtitles: result.subtitles,
    });
  }

  const filePath = resolveOutputPath(config.outputDir, args.output_path, responseFormat);
  await writeBuffer(filePath, result.buffer);
  const { size } = await stat(filePath);

  return textResult({
    kind: 'file',
    file: filePath,
    bytes: size,
    response_format: responseFormat,
    model,
    voice,
  });
}
