# 更新记录

## 0.2.0

- 新增声明式配置 `dfsc.settings.json`（json-file-v1）：DFSC 插件中心内可直接配置后端模式、接口地址、默认模型、API Key、输出目录，以及合成默认值（默认音色、默认语境、输出格式）。按调用传参仍优先于配置默认值。
- `step.plugin.json` 的 env 占位符切换为官方 sentinel `DFSC_INDEPENDENT_PLUGIN`；旧占位符 `stepaudio-managed-provider-context` 继续识别。
- 附带本地 WebUI 工作台进入设计阶段（0.3.0 实现，见 docs/webui-design.md）。
- 修复：本地音色目录兜底路径在打包产物中失效的问题（0.1.0 基线后修复，随本版发布）。

## 0.1.0

- 首个可用版本：`text_to_speech` / `list_voices` / `clone_voice` 三个 MCP 工具。
- 官方 MCP SDK 开发、esbuild 自包含打包，分发产物 `dist/index.js` 无运行时依赖。
- 支持 Step Plan 额度与任意 OpenAI 兼容网关两种后端。
- 配置：环境变量直填或插件目录外 CLI 私密配置（`scripts/configure.mjs`）。
