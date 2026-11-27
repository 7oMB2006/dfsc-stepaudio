#!/usr/bin/env node
/**
 * 构建自包含分发产物 dist/index.mjs，并归集 bundled 依赖的许可证到
 * dist/THIRD_PARTY_LICENSES.txt。范式对齐上游
 * desktop-for-step-code examples/plugins/sdk-host-starter/scripts/build.mjs：
 * 作者侧构建、产物提交进仓库、用户安装时不跑 npm/pip。
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
await mkdir(output, { recursive: true });
// 0.3.2 起入口使用 .mjs，避免社区安装目录缺少 package.json 时被 Node 当作 CommonJS。
await rm(join(output, 'index.js'), { force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.js'],
  outfile: join(output, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  metafile: true,
  legalComments: 'inline',
  charset: 'ascii',
  logLevel: 'warning',
});

// 归集被打进产物的第三方依赖许可证（仅统计 node_modules 输入，esbuild 自身不被打包）
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter((path) => path.includes('node_modules/'))) {
  let cursor = dirname(await realpath(resolve(root, input)));
  let metadata;
  while (true) {
    if (existsSync(join(cursor, 'package.json'))) {
      const value = JSON.parse(await readFile(join(cursor, 'package.json'), 'utf8'));
      if (typeof value.name === 'string' && typeof value.version === 'string') {
        metadata = value;
        break;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('Dependency package metadata missing');
    cursor = parent;
  }
  const name = `${metadata.name}@${metadata.version}`;
  if (packages.has(name)) continue;
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md'].find((file) =>
    existsSync(join(cursor, file)),
  );
  if (!license) throw new Error(`Bundled dependency has no license file: ${name}`);
  packages.set(name, await readFile(join(cursor, license), 'utf8'));
}

const notices = [...packages]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, license]) => `## ${name}\n\n${license.trim().replace(/\r\n/g, '\n')}\n`)
  .join('\n');
await writeFile(
  join(output, 'THIRD_PARTY_LICENSES.txt'),
  `Bundled dependency licenses. Versions are pinned in the author lockfile.\n\n${notices}`,
);
console.log(`Built self-contained MCP entry with ${packages.size} dependency license records.`);
