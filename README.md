# dfsc-StepAudio

DFSC 社区插件：把阶跃自家 **StepAudio TTS** 封装成标准 MCP 服务（stdio 传输，**自包含单文件分发**——开发期使用官方 MCP SDK，发布前打包为 `dist/index.js`，用户机器无需任何 npm 依赖，仅需 Node.js 20+）。按 [dfsc-community-plugins](https://github.com/7oMB2006/dfsc-community-plugins) 的插件骨架组织，MCP 声明见 `step.plugin.json`。

提供三个工具：

| 工具 | 作用 |
| --- | --- |
| `text_to_speech` | 文本 → 语音音频，支持全局语境 `instruction` 定调、括号内联指令、语速/音量/采样率控制，音频落盘并返回路径 |
| `list_voices` | 列出官方音色（名称/描述/推荐场景）与已复刻音色 |
| `clone_voice` | 上传参考音频（mp3/wav，5–10 秒）创建正式复刻音色，可选试听样本 |

## 安装（DFSC 市场）

1. DFSC「设置 → 插件 → 市场来源」添加社区市场 `https://github.com/7oMB2006/dfsc-community-plugins.git`（或本地目录）。
2. 在「发现」安装 **dfsc-stepaudio**，按提示重载会话。
3. 安装只复制资源、**不执行 npm install**——本插件分发为自包含单文件 `dist/index.js`（官方 MCP SDK 已在开发期打包进去），`node dist/index.js` 直接可运行（需要 PATH 上有 Node.js 20+）。

收录前也可本地联调：在 DFSC 的 MCP 配置里指向本目录的 `dist/index.js`。

## 配置

### DFSC 内（推荐）：插件中心设置页

在 DFSC 插件中心打开本插件的配置页直接填写，Key 由宿主保管（密码输入、不回显、只存宿主私密目录）：

| 设置项 | 说明 |
| --- | --- |
| 后端模式 | `stepplan` = Step Plan 登录态额度；`openapi` = 开放平台或任意 OpenAI 兼容网关 |
| 接口地址 | 留空按模式默认：`https://api.stepfun.com/step_plan/v1` 或 `https://api.stepfun.com/v1` |
| 默认模型 | `stepaudio-2.5-tts` / `stepaudio-3-tts` / `step-tts-2` / `step-tts-mini` |
| API Key | 必填；按所选渠道计费，不随聊天账户切换 |
| 输出目录 | 音频文件输出目录；留空使用系统临时目录（**请勿指向插件包内目录**） |
| 默认音色 / 默认语境 / 输出格式 | 合成默认值；每次合成时按次指定则优先于默认值 |

保存后按提示重启会话生效。修改已安装实例的配置不需要重装插件。

### 其他 MCP 客户端 / 本地开发：环境变量或 CLI 私密配置

`step.plugin.json` 的 `mcpServers.env` 只放官方哨兵 `DFSC_INDEPENDENT_PLUGIN`（写在宿主注入登录凭据的变量 `STEPFUN_API_KEY` 上，阻止自动注入）。非 DFSC 场景按以下顺序解析配置：

1. 环境变量直填（`STEP_API_KEY` / `STEPFUN_API_KEY` / `DFSC_STEP_PLAN_API_KEY`；哨兵值视为未配置）
2. 插件目录外的 CLI 私密配置：`STEPAUDIO_CONFIG_PATH`，或安装布局下的 `<step-runtime>/stepaudio/config.json`（`STEPAUDIO_PROFILE_DIR` 可覆盖 profile 位置）
3. 都不可用 → 返回带操作指引的配置错误

```powershell
# 复制模板到插件目录以外的私密位置并填入 Key，再登记
copy provider.example <私密目录>\provider.env
node scripts\configure.mjs --profile <私密目录> --mode independent --env-file <私密目录>\provider.env
node scripts\configure.mjs --profile <私密目录> --check
```

私密 env 文件支持的键见 `provider.example`。**env 文件指向插件目录内会被拒绝**（市场快照会公开插件目录）。

### 托管安装的行为边界

被 DFSC 安装后（位于 `<step-runtime>/plugins/dfsc-stepaudio`）：**只读宿主设置**，环境变量与 CLI 私密配置一律不参与；设置在插件中心被变更或撤销后，运行中的进程对后续调用返回“请重启服务”，不会静默使用旧配置或回退到其他来源。

## 工具参数要点

### text_to_speech

- `text`（必填，≤1000 字符）：括号 `()` 内内容作为指令处理、不发音
- `voice`（必填）：官方音色 ID 或复刻音色 ID，用 `list_voices` 查
- `instruction`：全局自然语言指导，`stepaudio-2.5-tts` ≤200 字符、`stepaudio-3-tts` ≤500 字符
- `response_format`：`mp3`/`wav`/`flac`/`opus`/`pcm`，默认 `mp3`
- `speed`（0.5–2）、`volume`（0.1–2）、`sample_rate`（8000–48000）
- `output_path`：指定输出文件；缺省写入 `STEPAUDIO_OUTPUT_DIR`（默认 `<插件目录>/output`）
- `return_url`：`true` 时不落盘，返回上游 URL（12 小时有效）与字幕（如有）

### list_voices

- `scope`：`official`（默认）/ `cloned` / `all`；`limit`、`order` 控制已复刻音色分页
- 官方音色优先调上游 `system_voices`，不可用时回退内置目录 `data/system-voices.json`

### clone_voice

- `audio_path` 或 `file_id` 二选一：前者自动上传（purpose=storage）
- `text`：参考音频转写，建议传入；`preview` + `sample_text`：生成试听样本
- 返回 `voice_id`（可直接作为 `text_to_speech` 的 `voice`）

## 开发

作者路线：**官方 MCP SDK 开发 → esbuild 自包含打包 → 提交 `dist/` 产物 → 市场安装 → 插件目录外预置配置 → 预留更新**（宿主已支持检查式更新并保留配置）。

```sh
npm install      # 仅开发依赖：@modelcontextprotocol/sdk 与 esbuild（用户机器不需要）
npm test         # pretest 自动 npm run build，再跑 node --test（61 个用例）
npm run build    # 单独打包：esbuild src/index.js -> dist/index.js
npm run smoke    # stdio 冒烟（启动 dist 产物）：initialize → tools/list → 错误路径
node scripts/make-icon.mjs   # 重新生成 icon.png
```

`dist/index.js` 是**提交进仓库的分发产物**（市场安装不执行 `npm install`，`.gitignore` 明确不忽略它）；改完 `src/` 必须重新 build 并提交，协议测试与冒烟都只认 dist 产物。

## 本机试用

需要 2026-11-09 之后构建的 DFSC 宿主（插件中心声明式配置能力）。

**重要**：添加市场源前先执行 `npm run stage` 导出干净发布目录（默认 `../dfsc-stepaudio-package`，仅含 git 跟踪的 51 个文件）。宿主对本地目录市场源可能整目录拷贝，直接指向仓库工作目录会把 `node_modules`/`.git` 一起拷进快照（实测 3725 文件/37MB），导致官方 reader 每次整包指纹从 30ms 恶化到 8 秒级、会话加载变慢。修改代码并提交后需重新 stage。

然后在 DFSC 中：**插件 → 市场来源 → 添加市场 → 本地目录**，选择导出目录；随后在「发现」安装 dfsc-stepaudio，重载会话，插件中心填 API Key 即可使用。

真机验收（17 项闸门）可用 `node scripts/acceptance-host.mjs` 对本地构建的宿主自动执行，需先用 `docs/host-build.md` 的方法构建宿主并通过 `HOST_DIR` 指定。真实 Key 端到端验证：`STEP_API_KEY=<key> node scripts/verify-real-api.mjs`。

目录结构、市场收录流程与宿主兼容边界见 [docs/dfsc-integration.md](docs/dfsc-integration.md)。

## 路线图

- 跟随 DFSC 模式：待宿主提供 StepAudio 桥接后实现（协议对齐 BVR 的 host.json 模式）
- 流式合成（WebSocket `/realtime/audio` 或 SSE）
- `voice_label`（情绪/风格/语言标签，step-tts 系列）
- 配套技能（音色选择与 instruction 写法指引）

## 参考

- [StepAudio 2.5 TTS 文档](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-2.5-tts) · [语音合成 API](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio) · [音色复刻 API](https://platform.stepfun.com/docs/zh/api-reference/audio/create-voice) · [Step Plan 语音接入](https://platform.stepfun.com/docs/zh/step-plan/integrations/audio-api)
- [DFSC 社区插件市场](https://github.com/7oMB2006/dfsc-community-plugins)
