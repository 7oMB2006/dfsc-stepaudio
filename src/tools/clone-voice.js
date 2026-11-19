import { access } from 'node:fs/promises';
import path from 'node:path';
import { defaultFileName, resolveOutputPath, writeBuffer } from '../lib/fs-utils.js';
import { McpToolError } from '../lib/errors.js';
import { cleanParams, textResult } from './shared.js';

const ALLOWED_EXTENSIONS = ['.mp3', '.wav'];
const CLONE_MODELS = ['stepaudio-2.5-tts', 'step-tts-2', 'step-tts-mini'];

export const definition = {
  name: 'clone_voice',
  description:
    '音色复刻：上传参考音频（mp3/wav，建议 5~10 秒）创建正式复刻音色，返回音色 ID（可用于 text_to_speech 的 voice）。可选 preview 先试听效果（不创建正式资产外的额外步骤，试听不另收费）。',
  inputSchema: {
    type: 'object',
    properties: {
      audio_path: { type: 'string', description: '本地参考音频路径（mp3/wav，5~10 秒）。与 file_id 二选一。' },
      file_id: { type: 'string', description: '已上传的参考音频 File ID。与 audio_path 二选一。' },
      model: { type: 'string', enum: CLONE_MODELS, description: '复刻用模型，默认取服务配置。' },
      text: { type: 'string', description: '参考音频对应的文本（转写），建议传入以保证效果。' },
      preview: { type: 'boolean', description: '复刻后是否生成试听样本并保存到 output 目录。' },
      sample_text: { type: 'string', description: '试听文本（preview=true 时必填，建议 50 字以内）。' },
      instruction: { type: 'string', description: '试听时的全局语境指导（仅 stepaudio-2.5-tts 生效，≤200 字符）。' },
    },
  },
};

export async function handler(args, ctx) {
  const { client, config } = ctx;

  const hasPath = typeof args.audio_path === 'string' && args.audio_path.trim() !== '';
  const hasFileId = typeof args.file_id === 'string' && args.file_id.trim() !== '';
  if (hasPath && hasFileId) {
    throw new McpToolError('audio_path 与 file_id 只能提供一个', { code: 'INVALID_ARGS' });
  }
  if (!hasPath && !hasFileId) {
    throw new McpToolError('必须提供 audio_path 或 file_id', { code: 'INVALID_ARGS' });
  }
  // preview 的前置校验必须在上传与创建之前：createVoice 是付费操作（9.9 元/音色），
  // 参数非法的请求不应产生已付费的音色资产再报错。
  const preview = args.preview === true;
  let sampleText = '';
  if (preview) {
    sampleText = String(args.sample_text ?? '').trim();
    if (sampleText === '') {
      throw new McpToolError('preview=true 时必须提供 sample_text（试听文本）', { code: 'INVALID_ARGS' });
    }
  }

  let fileId = args.file_id?.trim();
  let uploaded;
  if (hasPath) {
    const audioPath = path.resolve(args.audio_path.trim());
    try {
      await access(audioPath);
    } catch {
      throw new McpToolError(`参考音频不存在：${audioPath}`, { code: 'INVALID_ARGS' });
    }
    const ext = path.extname(audioPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new McpToolError(
        `不支持的参考音频格式 "${ext || '(无扩展名)'}"，仅支持 ${ALLOWED_EXTENSIONS.join(' / ')}（时长 5~10 秒）`,
        { code: 'INVALID_ARGS' },
      );
    }
    uploaded = await client.uploadFile(audioPath);
    fileId = uploaded.id;
  }

  const model = args.model ?? config.model;
  const voice = await client.createVoice(
    cleanParams({ model, file_id: fileId, text: args.text }),
  );

  const payload = {
    voice_id: voice.id,
    file_id: fileId,
    model,
    duplicated: voice.duplicated === true,
  };

  if (preview) {
    const previewResult = await client.previewVoice(
      cleanParams({
        model,
        file_id: fileId,
        sample_text: sampleText,
        text: args.text,
        instruction: args.instruction,
      }),
    );
    if (typeof previewResult.sample_audio !== 'string' || previewResult.sample_audio === '') {
      throw new McpToolError('试听失败：上游未返回音频数据', { code: 'UPSTREAM_BAD_RESPONSE' });
    }
    const previewPath = resolveOutputPath(config.outputDir, undefined, 'wav');
    await writeBuffer(previewPath, Buffer.from(previewResult.sample_audio, 'base64'));
    payload.preview_file = previewPath;
  }

  return textResult(payload);
}
