#!/usr/bin/env node
/**
 * 一键试用启动器：在独立 profile 里准备并启动装好 dfsc-StepAudio 的 DFSC 实例。
 * 不影响日用 DFSC（日用安装包是 10-25 构建，缺插件中心配置能力）。
 *
 * 用法：node scripts/trial-launch.mjs
 *   - 首次运行：创建试用 profile → 静默安装插件 → 启动实例
 *   - 再次运行：直接启动实例（插件已装）
 *   - 重置：删除 D:\StepFun\dfsc-trial-profile 后再运行
 *
 * 启动后用户操作：登录 Step 账号 → 插件中心打开 dfsc-stepaudio 配置 →
 * 填 API Key（openapi 模式 + 开放平台地址）→ 保存 → 重启会话 →
 * 对话里说“用 cixingnansheng 念：智能阶跃，十倍每一个人的可能”。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DIR = process.env.HOST_DIR ?? 'D:/StepFun/dfsc-host-build/desktop-for-step-code/Desktop';
const EXE = path.join(HOST_DIR, 'release', 'win-unpacked', 'Desktop for Step Code.exe');
const PROFILE = process.env.TRIAL_PROFILE ?? 'D:/StepFun/dfsc-trial-profile';

const hostRequire = createRequire(path.join(HOST_DIR, 'package.json'));
const { _electron: electron } = hostRequire('playwright');

async function ensureProfile() {
  await fs.mkdir(path.join(PROFILE, 'step-runtime'), { recursive: true });
  const prefs = path.join(PROFILE, 'preferences.json');
  if (!(await fs.access(prefs).then(() => true, () => false))) {
    await fs.writeFile(prefs, JSON.stringify({ language: 'zh', theme: 'dark', workspaces: [] }));
  }
  const toml = path.join(PROFILE, 'step-runtime', 'config.toml');
  if (!(await fs.access(toml).then(() => true, () => false))) {
    await fs.writeFile(toml, '[telemetry]\nenabled = false\n');
  }
}

async function ensureInstalled() {
  const marker = path.join(PROFILE, 'step-runtime', 'plugins', 'dfsc-stepaudio', 'step.plugin.json');
  if (await fs.access(marker).then(() => true, () => false)) {
    console.log('插件已安装，跳过安装步骤');
    return;
  }
  console.log('首次运行：静默安装插件……');
  const app = await electron.launch({
    executablePath: EXE,
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    env: { ...process.env, DESKTOP_TEST_USER_DATA: PROFILE, DESKTOP_TEST_NO_FOCUS: '1' },
    timeout: 60000,
  });
  try {
    const main = await app.firstWindow();
    main.setDefaultTimeout(30000);
    await main.waitForFunction(() => typeof window.desktop?.updateState === 'function');
    const mutate = (input) => main.evaluate((i) => window.desktop.capabilityMutate(i), input);
    const catalog = () => main.evaluate(() => window.desktop.capabilityCatalog());
    const added = await mutate({ action: 'marketplace-add', source: pathToFileURL(PLUGIN_ROOT).href });
    if (added?.warnings?.length) throw new Error(`市场源添加告警：${JSON.stringify(added.warnings)}`);
    const available = (await catalog()).available?.find((item) => item.name === 'dfsc-stepaudio');
    if (!available) throw new Error('市场目录中未找到 dfsc-stepaudio');
    await mutate({ action: 'plugin-install', ref: available.ref, name: available.name, marketplace: available.marketplace });
    const installed = (await catalog()).plugins?.find((plugin) => plugin.id === 'dfsc-stepaudio');
    if (!installed?.package?.provenance === 'recorded' && !installed) throw new Error('安装失败');
    console.log('插件安装完成');
  } finally {
    await app.close();
  }
}

await ensureProfile();
await ensureInstalled();

// 启动实例（detached，脱离本进程）
const child = spawn(EXE, ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], {
  env: { ...process.env, DESKTOP_TEST_USER_DATA: PROFILE, DESKTOP_TEST_NO_FOCUS: '1' },
  detached: true,
  stdio: 'ignore',
});
child.unref();
console.log(`\n试用实例已启动（profile: ${PROFILE}）`);
console.log('接下来：');
console.log('  1. 在窗口里登录你的 Step 账号');
console.log('  2. 插件中心 → dfsc-stepaudio → 配置 → 填 API Key（模式 openapi，地址 https://api.stepfun.com/v1）');
console.log('  3. 保存 → 按提示重启会话');
console.log('  4. 对话里说：用 cixingnansheng 念：智能阶跃，十倍每一个人的可能');
console.log(`\n重置：删除目录 ${PROFILE} 后重跑本脚本`);
