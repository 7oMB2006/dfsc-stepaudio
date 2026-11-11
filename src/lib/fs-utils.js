import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 输出格式 -> 文件扩展名（与 API 的 response_format 对齐）。 */
export const FORMAT_EXTENSIONS = {
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  opus: 'opus',
  pcm: 'pcm',
};

/** 用时间戳生成默认文件名，避免并行请求互相覆盖。 */
export function defaultFileName(format) {
  const ext = FORMAT_EXTENSIONS[format] ?? 'mp3';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `tts-${stamp}.${ext}`;
}

/** 解析最终输出路径：调用方给了 output_path 就用它，否则落到输出目录。 */
export function resolveOutputPath(outputDir, outputPath, format) {
  const target = outputPath
    ? path.resolve(outputPath)
    : path.join(path.resolve(outputDir), defaultFileName(format));
  return target;
}

export async function ensureDirFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeBuffer(filePath, buffer) {
  await ensureDirFor(filePath);
  await fs.writeFile(filePath, buffer);
  return filePath;
}
