import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpToolError } from './errors.js';

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

/**
 * 托管安装下，逐次 output_path 与 output_dir 受同一条约束：不得指向插件包内。
 * 写入包内会改变 ConfigurationReader 校验的包指纹，导致后续调用全部 fail-closed，
 * 且重新保存配置也无法恢复原安装指纹。必须在发起合成之前调用。
 */
export function assertOutputOutsidePackage(filePath, pluginRoot, managed) {
  if (!managed) return filePath;
  const root = path.resolve(pluginRoot);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new McpToolError(
      `输出路径不能位于插件包内（会破坏安装完整性校验）：${target}`,
      { code: 'INVALID_ARGS' },
    );
  }
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
