# DFSC 接入文档

本文记录 dfsc-StepAudio 与 DFSC 的对接方式，约定以社区市场仓库 [7oMB2006/dfsc-community-plugins](https://github.com/7oMB2006/dfsc-community-plugins)（2026-11 现状，含 MCP 插件范例 `bilibili-video-research`）为准。

## 1. 插件清单：step.plugin.json

MCP 能力通过 `mcpServers` 段声明（字段取自 BVR 范例）：

```json
{
  "mcpServers": {
    "stepaudio": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": { "STEPFUN_API_KEY": "stepaudio-managed-provider-context" },
      "startup_timeout_sec": 60,
      "tool_timeout_sec": 300
    }
  }
}
```

- `args` 相对插件目录，指向**自包含打包产物** `dist/index.js`（官方 MCP SDK 已在开发期用 esbuild 打入，市场安装不执行 `npm install`，用户机器无任何 npm 依赖）。
- MCP 标识为 `dfsc-stepaudio__stepaudio`（插件 ID + 服务名）。
- `env` 里的 `stepaudio-managed-provider-context` 是**非密钥占位符**，且必须写在宿主自动注入登录凭据所使用的变量 `STEPFUN_API_KEY` 上（对齐 BVR 约定）——写在其他变量名（如 `STEP_API_KEY`）无法阻止宿主把真实凭据注入 MCP 子进程。取值等于占位符时服务视为"未配置"，转去读插件目录外的私密配置。
- 作者路线：官方 MCP SDK 开发 → `npm run build` 打包 → 提交 `dist/` → 市场安装 → 插件目录外预置配置 → 预留更新（宿主已支持检查式更新并保留配置）。

## 2. 两种模式

### 独立模式（当前唯一可用）

`mcpServers.env` 放不了用户真实 Key，因此私密凭据保存在插件目录外：

```text
<profile>/stepaudio/config.json      # {"schemaVersion":1,"mode":"independent","envFile":"<绝对路径>"}
<任意插件目录外位置>/provider.env     # STEP_API_KEY=... 等
```

- 由 `node scripts/configure.mjs --profile <目录> --mode independent --env-file <绝对路径>` 写入，`--check` 复查，`--replace` 才允许覆盖。
- 服务解析顺序：环境变量直填（占位符跳过）→ `STEPAUDIO_CONFIG_PATH` → 安装布局 `<step-runtime>/stepaudio/config.json`（`<step-runtime>` = 插件目录的上两级；本地开发用 `STEPAUDIO_PROFILE_DIR` 覆盖）。
- env 文件位于插件目录内一律拒绝（市场快照会公开它）；文件大小上限 128 KiB。
- 独立模式支持 Step Plan（`https://api.stepfun.com/step_plan/v1`）、开放平台（`/v1`）与任意 OpenAI 兼容网关（`STEPAUDIO_BASE_URL` 自定义）。

### 跟随 DFSC 模式（宿主不支持，占位）

BVR 的实现方式：宿主在主进程代发模型请求，不向插件导出 Key；宿主在 `<step-runtime>/bvr/host.json` 写下 `{url: "http://127.0.0.1:<port>/", version: 1, token: "<64 hex>"}`，插件运行体读取后用该 token 走本地桥接。**这是 BVR 专用宿主能力**（DFSC main `12c13170f8f80945cfa245c1297b81d527f3ff23` 起包含"BVR 宿主桥"）。

对 StepAudio 尚无同类桥接。本插件的处理：

- 私密配置若为 `schemaVersion: 2 + mode: "dfsc"`，服务返回明确错误（需要宿主桥接，指引独立模式），**不发明桥接协议、不回退直连**。
- 宿主提供通用/StepAudio 桥接后，按同一 host.json 模式实现：读取 `<step-runtime>/stepaudio/host.json`，模型请求走本地桥接，Key 与登录 Cookie 不进入插件进程。

## 3. dfsc.plugin.json（分类契约）

可选文件，市场按原始字节锁定：

- `schemaVersion: 1`；`categories` 取 1–3 个稳定 ID（`development`/`research`/`text-documents`/`knowledge`/`audio-video`/`image-design`/`automation`/`themes`），本插件用 `audio-video` + `automation`。
- `keywords` 最多 5 项，每项 ≤48 个 UTF-16 码元，本插件用「语音合成 / TTS / 音色复刻 / StepAudio / 配音」。
- 另可声明 `authors`、`license`、`documentation.readme`、`locales.zh/en.description`。分类描述用途，不代表能力类型或已配置状态。

## 4. 市场收录流程

1. 插件先在独立仓库开发发布；本目录可推为独立 repo。
2. 在社区仓库 `registry.json` 增加条目：上游仓库、**完整 40 位 commit SHA**、资源路径、license、readme 路径（`docs/plugins/dfsc-stepaudio.md`，会被同步工具用来替换资源目录内的 README）。
3. `python3 scripts/sync-plugin.py --plugin dfsc-stepaudio` 生成 `plugins/dfsc-stepaudio/`、锁定记录与市场清单；`python3 scripts/validate-marketplace.py --check`；`python3 -m unittest discover -s tests -v`。
4. 新能力形态需用一次性 DFSC 数据目录做原生验收：`node integration/verify-dfsc.mjs <市场目录>`，记录宿主版本与结果到 `test-results/`。
5. PR 说明用户得到什么、来源提交、依赖、许可证与实际验证范围。

注意：市场安装不升级宿主能力；旧宿主可能忽略 `dfsc.plugin.json` 的可选字段。

## 5. 宿主兼容边界

- 需要：支持原生插件、插件相对工作目录、并从 `step.plugin.json` 加载 `mcpServers` 的 DFSC 宿主；PATH 上可用的 Node.js 20+。
- 已验证：本仓库内 46 个单元测试（含 step.plugin.json / dfsc.plugin.json 契约、配置解析链、协议冒烟；协议测试启动实际打包产物）+ stdio 冒烟 + configure CLI 读写与拒绝路径 + 自包含验证（移走 node_modules 后 dist/index.js 仍能启动并响应 initialize/tools/list）。
- 未验证：真实 DFSC 宿主中的市场发现/安装/加载/卸载；真实 Step Plan key 下的合成、音色查询、复刻计费。这些需要宿主与凭据，按社区要求单独记录。

## 6. 本地联调

任意 MCP 客户端可直接以 stdio 连接。优先用分发产物（无需开发依赖）：

```sh
STEP_API_KEY=<key> node dist/index.js
```

开发期也可以直接跑源码（需先 `npm install` 装上 SDK 与 esbuild）：

```sh
STEP_API_KEY=<key> node src/index.js
```

或用环境变量直连 + 私密配置两种路径分别验证（`STEPAUDIO_CONFIG_PATH` 指向临时 config.json）。
