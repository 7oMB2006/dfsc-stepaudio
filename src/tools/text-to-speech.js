import { stat } from 'node:fs/promises';
import { resolveOutputPath, writeBuffer } from '../lib/fs-utils.js';
import { McpToolError } from '../lib/errors.js';
import { cleanParams, textResult } from './shared.js';

const RESPONSE_FORMATS = ['mp3', 'wav', 'flac', 'opus', 'pcm'];
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 48000];
/** instruction 长度上限（按模型，来自平台文档）。 */
const INSTRUCTION_LIMITS = {
  'stepaudio-2.5-tts': 200,
  'stepaudio-3-tts': 500,
};

export const definition = {
  name: 'text_to_speech',
  description:
    '把文本合成为语音音频（阶跃 StepAudio TTS）。支持全局语境 instruction 定调、括号内联指令、语速/音量/采样率控制。音频写入文件并返回绝对路径。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要合成的文本，最大 1000 字符。括号 () 内内容作为指令处理、不发音。' },
      voice: { type: 'string', description: '音色 ID，官方音色或已复刻音色（可用 list_voices 查询）。' },
      model: { type: 'string', description: '模型，如 stepaudio-2.5-tts / stepaudio-3-tts / step-tts-2 / step-tts-mini。' },
      instruction: { type: 'string', description: '全局自然语言指导（情绪基调、人设），stepaudio-2.5-tts 上限 200 字符。' },
      response_format: { type: 'string', enum: RESPONSE_FORMATS, description: '音频格式，默认 mp3。' },
      speed: { type: 'number', description: '语速 0.5~2，默认 1.0。' },
      volume: { type: 'number', description: '音量 0.1~2.0，默认 1.0。' },
      sample_rate: { type: 'integer', enum: SAMPLE_RATES, description: '采样率，默认 24000。' },
      output_path: { type: 'string', description: '输出文件路径（绝对或相对）；缺省写入插件 output 目录。' },
      return_url: { type: 'boolean', description: 'true 时不落盘，返回上游文件 URL（12 小时有效）与字幕（如有）。' },
    },
    required: ['text', 'voice'],
  },
};

export async function handler(args, ctx) {
  const { client, config } = ctx;
  const text = String(args.text ?? '');
  if (text.trim() === '') throw new McpToolError('text 不能为空', { code: 'INVALID_ARGS' });
  if (text.length > 1000) {
    throw new McpToolError(`text 超长：${text.length} 字符，上限 1000`, { code: 'INVALID_ARGS' });
  }
  const voice = String(args.voice ?? '').trim();
  if (voice === '') throw new McpToolError('voice 不能为空', { code: 'INVALID_ARGS' });

  const model = args.model ?? config.model;
  const instruction = args.instruction;
  if (instruction !== undefined) {
    const limit = INSTRUCTION_LIMITS[model];
    if (limit !== undefined && instruction.length > limit) {
      throw new McpToolError(`instruction 超长：${instruction.length} 字符，模型 ${model} 上限 ${limit}`, {
        code: 'INVALID_ARGS',
      });
    }
  }

  const responseFormat = args.response_format ?? 'mp3';
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
