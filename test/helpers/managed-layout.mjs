/**
 * 托管布局测试夹具：在临时目录构造宿主数据目录与假插件包。
 * 指纹与哈希算法和官方读取器（src/lib/dfsc-config.mjs）逐字节对齐：
 * - fingerprint：递归包目录，条目按 name.localeCompare 排序，
 *   digest.update(JSON.stringify([相对路径, 字节长度])) + 文件内容
 * - schemaHash：dfsc.settings.json 原始字节的 sha256
 * - contentHash：对解析后再序列化的快照对象取 sha256
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INSTANCE = 'a1b2c3d4-1234-1234-1234-123456789abc';
export const REVISION = 'a'.repeat(64);
export const PLUGIN_ID = 'dfsc-stepaudio';

const tempDirs = [];

export async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 与官方读取器一致的包指纹。 */
export async function fingerprintPackage(root) {
  const digest = createHash('sha256');
  async function visit(relative = '') {
    const entries = (await readdir(relative ? path.join(root, relative) : root, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('包内不允许符号链接');
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else {
        const bytes = await readFile(path.join(root, child));
        digest.update(JSON.stringify([child, bytes.length])).update(bytes);
      }
    }
  }
  await visit();
  return digest.digest('hex');
}

/**
 * 构造托管布局：
 * <root>/plugins/dfsc-stepaudio/            假插件包（packageFiles 指定的真实文件副本）
 * <root>/desktop-plugins/bindings/dfsc-stepaudio.json
 * <root>/desktop-plugins/installations.json
 * <root>/desktop-plugins/settings/<instance>/<revision>.json
 */
export async function createManagedLayout({
  values = {},
  secrets = {},
  withSnapshot = true,
  packageFiles = ['package.json', 'step.plugin.json', 'dfsc.settings.json'],
} = {}) {
  const root = await makeTempDir('dfsc-stepaudio-managed-');
  const pkg = path.join(root, 'plugins', PLUGIN_ID);
  await mkdir(path.join(pkg, 'dist'), { recursive: true });
  for (const file of packageFiles) {
    await mkdir(path.dirname(path.join(pkg, file)), { recursive: true });
    await copyFile(path.join(PLUGIN_ROOT, file), path.join(pkg, file));
  }

  const settingsBytes = await readFile(path.join(PLUGIN_ROOT, 'dfsc.settings.json'));
  const schemaHash = sha256(settingsBytes);
  const snapshot = { version: 1, instance: INSTANCE, id: PLUGIN_ID, revision: REVISION, schemaHash, values, secrets };

  const settingsDir = path.join(root, 'desktop-plugins', 'settings', INSTANCE);
  await mkdir(settingsDir, { recursive: true });
  const snapshotPath = path.join(settingsDir, `${REVISION}.json`);
  if (withSnapshot) {
    await writeFile(snapshotPath, JSON.stringify(snapshot));
  }

  const contentHash = sha256(JSON.stringify(JSON.parse(JSON.stringify(snapshot))));
  const fingerprint = await fingerprintPackage(pkg);
  const binding = { version: 1, instance: INSTANCE, id: PLUGIN_ID, revision: REVISION, schemaHash, contentHash, fingerprint };

  await mkdir(path.join(root, 'desktop-plugins', 'bindings'), { recursive: true });
  await writeFile(path.join(root, 'desktop-plugins', 'bindings', `${PLUGIN_ID}.json`), JSON.stringify(binding));
  await writeFile(
    path.join(root, 'desktop-plugins', 'installations.json'),
    JSON.stringify({
      version: 1,
      installations: [{ instance: INSTANCE, folder: PLUGIN_ID, id: PLUGIN_ID, state: 'installed', fingerprint }],
    }),
  );
  return { root, pkg, snapshotPath };
}
