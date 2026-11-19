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
 * 同时刷新仓库内的社区市场快照 plugins/dfsc-stepaudio/：
 * 社区市场（dfsc-community-plugins）的同步工具按 registry 的 source.path 抓取
 * 该目录全部文件，且其校验器禁止 .env.* 资源路径、不接受开发清单与测试。
 * 因此快照是策展集合（宿主发布清单 + dfsc.host.json + vendored client + 面向用户的
 * 文档），不含 .env.example——后者只保留在仓库根，供宿主官方发布验收脚本使用。
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
  // plugins/ 是社区市场快照（见下），不进本地发布包，避免递归包含。
  .filter((file) => file !== 'test' && !file.startsWith('test/') && !file.startsWith('plugins/'));

if (files.length === 0) {
  console.error('git ls-files 为空：仓库是否有未提交的变更？');
  process.exit(1);
}

/** 社区市场快照的策展集合：目录条目按前缀匹配展开。 */
const MARKET_ENTRIES = [
  'step.plugin.json', 'dfsc.host.json', 'dfsc.plugin.json', 'dfsc.settings.json',
  'dist', 'data', 'README.md', 'CHANGELOG.md', 'LICENSE', 'UPSTREAM.md', 'icon.png',
  'provider.example', 'scripts/configure.mjs', 'src/lib/env-file.js', 'src/lib/errors.js',
  'src/lib/host-client',
  'docs/dfsc-integration.md', 'docs/start.md', 'docs/voices.md',
  'docs/recipes.md', 'docs/acceptance-runbook.md',
];
const marketFiles = files.filter((file) => MARKET_ENTRIES.some(
  (entry) => file === entry || file.startsWith(`${entry}/`),
));

/** 先在暂存目录构建，再原子替换：宿主的 marketplace-update 会在后台整目录拷贝，
 *  旧的 rm+逐个拷贝会让它撞上半成品目录（实测连续 marketplace-failed）。 */
async function publish(destination, selected) {
  const staging = `${destination}.staging`;
  await fs.rm(staging, { recursive: true, force: true });
  for (const file of selected) {
    const dest = path.join(staging, file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(root, file), dest);
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(staging, destination);
  return selected.length;
}

const staged = await publish(target, files);
const market = await publish(path.join(root, 'plugins', 'dfsc-stepaudio'), marketFiles);
console.log(`已导出 ${staged} 个受跟踪文件 → ${target}`);
console.log(`已刷新社区市场快照 ${market} 个文件 → ${path.join(root, 'plugins', 'dfsc-stepaudio')}`);
console.log('在 DFSC「市场来源 → 添加市场 → 本地目录」中请选择该目录。');
console.log('注意：修改代码并 git commit 后，需重新运行本脚本再更新市场源。');
