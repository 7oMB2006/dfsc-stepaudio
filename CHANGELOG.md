# 更新记录

## 0.1.0

- 首个可用版本：`text_to_speech` / `list_voices` / `clone_voice` 三个 MCP 工具。
- 官方 MCP SDK 开发、esbuild 自包含打包，分发产物 `dist/index.js` 无运行时依赖。
- 支持 Step Plan 额度与任意 OpenAI 兼容网关两种后端。
- 配置：环境变量直填或插件目录外 CLI 私密配置（`scripts/configure.mjs`）。
