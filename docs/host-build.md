# 宿主验收包构建记录（2026-11-14）

> 用途：为 dfsc-StepAudio 真机安装验收提供本地构建的 DFSC 宿主。
> 位置：`D:\StepFun\dfsc-host-build\`（2.4GB，与插件仓库隔离，不进入插件发布物）。

## r8 构建（2026-11-15，用户构建）

| 项 | 值 |
| --- | --- |
| 目录 | `D:\DFSC Builds\main-20261115-036ae94\` |
| desktopBase | `036ae94e50b60251a540564a5ce3ae4991328e00`（上游 #247 merge commit，TTS broker 生产适配自此可用） |
| runtime | node v24.16.0（sha256 `b3094d0b…`），entry `step/dist/bundle/step.js` |
| 用途 | 宿主官方 `verify-stepaudio-release.mjs` 验收（10/10 通过）；runtime 目录 `<包>/win-unpacked/resources/runtime` 含 `step/dist/bundle/index.js` 与 `node/node.exe` |
| 备注 | r7 及更旧包**不含** TTS broker 适配；跟随模式必须查 `context()` 判断，不能看版本号 |

## 产物

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| NSIS 安装包 | `desktop-for-step-code/Desktop/release/Desktop.for.Step.Code.Setup.0.6.0.exe` | 158.7 MB，x64，**未签名**（SmartScreen 会警告，本地验收正常） |
| 便携版 | `desktop-for-step-code/Desktop/release/win-unpacked/` | 免安装直接运行，验收推荐用这个 |
| 构建中间产物 | `desktop-for-step-code/Desktop/dist/` + `runtime/`（129M，已 stage） | main 源码构建 + pinned runtime |

## 构建 provenance（可复现）

- 宿主源码：`desktop-for-step-code` clone 自 `7oMB2006/desktop-for-step-code` main（含 #215–#238，2026-11-13 合并）。
- 运行时：`Step-Code` clone 自 `stepfun-ai/Step-Code` **固定提交 29eb460780489801ce8afc8bffc1a2efae7cbded**（CI 同款），`core.autocrlf false`，应用累积补丁 `patches/v017/step-code-desktop.patch`（diff --check 通过）。
- canvas 原生预构建：`scripts/ci-canvas-prebuild.mjs`（node-canvas v3.2.3 win32-x64，sha256 校验通过）。
- Step-Code 构建：pnpm install（frozen）+ pnpm build（7 包 + apps/cli + coding-agent bundle 27 文件 9.9MiB）。
- Runtime staging：`node scripts/stage-runtime.mjs`（需 `DESKTOP_STEP_CODE_SOURCE=D:/StepFun/dfsc-host-build/Step-Code`，因默认路径是 Desktop/../Step-Code）。

## 本地环境适配（与 CI 的差异）

| 问题 | 解法 |
| --- | --- |
| GitHub release 资产下载被墙 | 走本机代理 `HTTPS_PROXY=http://127.0.0.1:7897`（用户提供） |
| staging 要求 Node ≥24.16.0（24.15 有 TCP 崩溃缺陷），本机是 24.15.0 | 下载 node-v24.22.3-win-x64 至 `toolchain/`，用该 node 跑 staging |
| `pnpm run` 脚本内 spawn git ENOENT（pnpm 脚本环境 PATH 丢失） | staging 等脚本直接用 `node scripts/xxx.mjs` 跑，不经 pnpm |
| `pnpm package` 会重跑 stage:runtime（旧 node + 缺源码路径） | staging 单独完成后，直接跑 `node_modules/.bin/electron-builder --win nsis --x64` |

## 复现命令序列

```bash
# 1. 宿主源码
git clone --depth 1 https://github.com/7oMB2006/desktop-for-step-code.git
# 2. Step-Code 固定提交 + 补丁
git init Step-Code && git -C Step-Code config core.autocrlf false
git -C Step-Code remote add origin https://github.com/stepfun-ai/Step-Code.git
git -C Step-Code fetch --depth 1 --no-tags origin 29eb460780489801ce8afc8bffc1a2efae7cbded
git -C Step-Code checkout --detach FETCH_HEAD
node scripts/apply-step-code-desktop-patch.mjs Step-Code patches/v017/step-code-desktop.patch
# 3. 依赖与构建（代理按需）
(cd Desktop && corepack pnpm install)
node scripts/ci-canvas-prebuild.mjs "$TEMP/dfsc-canvas-prebuilds"   # 需代理
(cd Step-Code && npm_config_canvas_local_prebuilds=... corepack pnpm install --frozen-lockfile && corepack pnpm build)
# 4. staging（用 ≥24.16 的 node）+ 打包
(cd Desktop && DESKTOP_STEP_CODE_SOURCE=../Step-Code <node24.16+> scripts/stage-runtime.mjs)
(cd Desktop && ./node_modules/.bin/electron-builder --win nsis --x64)
```

## 下一步

按 `docs/acceptance-runbook.md` 执行验收：以 `win-unpacked` 便携版 + `DESKTOP_TEST_USER_DATA=<临时目录>` 隔离启动，添加本仓库为本地市场源安装插件，走设置页/合成/fail-closed/生命周期各闸门。
