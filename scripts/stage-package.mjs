#!/usr/bin/env node
/**
 * 导出干净发布目录：只包含 git 跟踪的文件。
 *
 * 背景：DFSC 宿主对本地目录市场源可能整目录拷贝（不尊重 .gitignore），
 * 仓库工作目录里的 node_modules/.git 会被拷进市场快照（实测 3725 文件/37MB），
 * 导致官方 reader 每次整包指纹从 30ms 恶化到 8 秒级。
 *
 * 本脚本用 git ls-files 导出受跟踪文件到仓库外的干净目录；
 * 在 DFSC 中添加市场源时必须指向该目录，不要指向仓库工作目录。
 *
 * 用法：node scripts/stage-package.mjs [目标目录]
 * 默认目标：<仓库上一级>/dfsc-stepaudio-package
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? path.join(root, '..', 'dfsc-stepaudio-package'));

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  // test/ 只在开发期使用：其中的 host-client/testing.mjs 是离线测试助手，
  // 上游 PLUGIN_TTS_ADAPTER.md 明确要求不得打入发布物。
  .filter((file) => file !== 'test' && !file.startsWith('test/'));

if (files.length === 0) {
  console.error('git ls-files 为空：仓库是否有未提交的变更？');
  process.exit(1);
}

// 先在暂存目录构建，再原子替换：宿主的 marketplace-update 会在后台整目录拷贝，
// 旧的 rm+逐个拷贝会让它撞上半成品目录（实测连续 marketplace-failed）。
const staging = `${target}.staging`;
await fs.rm(staging, { recursive: true, force: true });
for (const file of files) {
  const dest = path.join(staging, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(path.join(root, file), dest);
}
await fs.rm(target, { recursive: true, force: true });
await fs.rename(staging, target);

console.log(`已导出 ${files.length} 个受跟踪文件 → ${target}`);
console.log('在 DFSC「市场来源 → 添加市场 → 本地目录」中请选择该目录。');
console.log('注意：修改代码并 git commit 后，需重新运行本脚本再更新市场源。');
