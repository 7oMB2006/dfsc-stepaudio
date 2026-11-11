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

## 配置：独立模式（当前唯一可用方式）

市场安装场景下 `mcpServers.env` 只有占位符 `stepaudio-managed-provider-context`，且按社区约定写在宿主注入登录凭据所使用的变量 **`STEPFUN_API_KEY`** 上（写在其他变量名无法阻止宿主把真实凭据注入 MCP 子进程）。真实 Key 保存在**插件目录之外**的私密 env 文件中：

```powershell
# 1. 复制模板到插件目录以外的私密位置并填入 Key
copy provider.example D:\Private\stepaudio\provider.env

# 2. 写入私密配置（<profile>\stepaudio\config.json 指向该 env 文件）
node scripts\configure.mjs --profile D:\Private\stepaudio --mode independent --env-file D:\Private\stepaudio\provider.env

# 3. 复查（不发起任何提供商请求）
node scripts\configure.mjs --profile D:\Private\stepaudio --check
```

然后在 DFSC 中重载会话。服务按以下顺序解析配置：

1. 环境变量直填（`STEP_API_KEY` / `STEPFUN_API_KEY` / `DFSC_STEP_PLAN_API_KEY`，占位符视为未配置）
2. 私密配置：`STEPAUDIO_CONFIG_PATH`，或安装布局下的 `<step-runtime>/stepaudio/config.json`（`STEPAUDIO_PROFILE_DIR` 可覆盖 profile 位置）
3. 都不可用 → 返回带操作指引的配置错误

私密 env 文件支持的键见 `provider.example`：`STEP_API_KEY`、`STEPAUDIO_MODE`（`stepplan`=Step Plan 额度 / `openapi`=开放平台或任意 OpenAI 兼容网关）、`STEPAUDIO_BASE_URL`、`STEPAUDIO_MODEL`、`STEPAUDIO_OUTPUT_DIR`。**env 文件指向插件目录内会被拒绝**（市场快照会公开插件目录）。

## 跟随 DFSC 模式（暂不可用）

`step.plugin.json` 的占位符对应社区约定的"跟随 DFSC 会话账户"模式：宿主在主进程代发请求，不向插件导出 Key。该能力目前是 BVR 插件专用的宿主桥接（`127.0.0.1` + `host.json` token），**DFSC 宿主尚未对 StepAudio 提供同类桥接**。检测到跟随配置时，服务会返回明确错误并指引改用独立模式；宿主支持后会随 `docs/dfsc-integration.md` 更新。

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
npm test         # pretest 自动 npm run build，再跑 node --test（46 个用例）
npm run build    # 单独打包：esbuild src/index.js -> dist/index.js
npm run smoke    # stdio 冒烟（启动 dist 产物）：initialize → tools/list → 错误路径
node scripts/make-icon.mjs   # 重新生成 icon.png
```

`dist/index.js` 是**提交进仓库的分发产物**（市场安装不执行 `npm install`，`.gitignore` 明确不忽略它）；改完 `src/` 必须重新 build 并提交，协议测试与冒烟都只认 dist 产物。

目录结构、市场收录流程与宿主兼容边界见 [docs/dfsc-integration.md](docs/dfsc-integration.md)。

## 路线图

- 跟随 DFSC 模式：待宿主提供 StepAudio 桥接后实现（协议对齐 BVR 的 host.json 模式）
- 流式合成（WebSocket `/realtime/audio` 或 SSE）
- `voice_label`（情绪/风格/语言标签，step-tts 系列）
- 配套技能（音色选择与 instruction 写法指引）

## 参考

- [StepAudio 2.5 TTS 文档](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-2.5-tts) · [语音合成 API](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio) · [音色复刻 API](https://platform.stepfun.com/docs/zh/api-reference/audio/create-voice) · [Step Plan 语音接入](https://platform.stepfun.com/docs/zh/step-plan/integrations/audio-api)
- [DFSC 社区插件市场](https://github.com/7oMB2006/dfsc-community-plugins)
