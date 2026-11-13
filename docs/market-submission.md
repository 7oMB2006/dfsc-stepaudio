# 市场收录提交材料（草稿，待真机验收后执行）

> 状态：**草稿**。执行顺序有硬门：先完成真机安装验收（见清单第 1 项），再推送仓库、刷新 SHA、提 registry PR。本文件是给用户（提交执行人）的直接用料。

## 一、提交前核对清单

- [ ] **真机安装验收（硬门）**：一次性 DFSC 数据目录安装本插件，验证：市场发现/安装 → 插件中心设置页渲染 8 字段 → 填 Key 保存 → 重启会话 → `text_to_speech` 真实合成 → 改设置后下次调用 fail-closed → 停用/重启/卸载。通过后才继续。
- [ ] **`requirements.dfsc` 声明**：验收通过后，在 `dfsc.plugin.json` 补 `requirements.dfsc`（填写自己验证过的范围，如 `>=0.6.0 <1.0.0`），同步 `test/manifest.test.js` 已有校验。
- [ ] **推送独立仓库**：用户提供 GitHub 账号后执行 `git push`，确认远端默认分支为 `main`。
- [ ] **刷新 SHA**：registry 条目必须使用最终提交的完整 40 位 SHA（见下方草稿，执行时替换）。
- [ ] **内部文档去留决策**：`docs/marketplace-research.md`（上游机制研究）与 `docs/webui-design.md`（WebUI 设计）是开发期文档，会随资源目录进入市场快照。若不想公开，在提交前移到仓库外或删节；`UPSTREAM.md`（vendor 来源）建议保留——评审时需要溯源。
- [ ] **全绿确认**：`npm test`（60/60）、`npm run smoke`、`npm run build` 后 `git status` 干净。

## 二、发布物核对（2026-11-13，提交 7cdb413）

- 46 个文件；`dist/` 640K（`index.js` 632K + `THIRD_PARTY_LICENSES.txt`）、`data/` 12K、`icon.png` 12.7K——远低于市场单文件 8 MiB / 总计 32 MiB / 1000 文件上限。
- 无 `node_modules`、无真实 `.env`、无 `output/`、无本机绝对路径（示例文件已改通用占位）。
- `dist/index.js` 为自包含产物（官方 MCP SDK + vendor 读取器已打入，用户机器零 npm 依赖）。
- 运行时依赖：仅 Node.js 20+（已在 `dfsc.plugin.json` 的 `requirements.external` 声明）。

## 三、registry.json 条目草稿

```json
{
  "id": "dfsc-stepaudio",
  "description": "阶跃 StepAudio TTS 的 MCP 服务：文本转语音、音色列表、音色复刻；DFSC 插件中心内配置，零运行时依赖（自包含 dist）。",
  "source": {
    "repository": "<用户GitHub账号>/dfsc-stepaudio",
    "commit": "<最终提交的 40 位 SHA>",
    "path": "."
  },
  "license": "MIT",
  "readme": "docs/plugins/dfsc-stepaudio.md"
}
```

注意：`path` 为本插件仓库根（资源直接位于仓库根，不像 BVR 有 `plugins/<id>` 子目录）；`readme` 由市场维护者编写，同步工具会用它替换资源根的 README。

## 四、docs/plugins/dfsc-stepaudio.md 内容草稿（供维护者改编）

```markdown
# dfsc-stepaudio（阶跃 StepAudio 语音）

版本 0.2.0。把阶跃 StepAudio TTS 能力接入 DFSC 会话的 MCP 插件。

提供三个工具：text_to_speech（文本合成语音，支持全局 instruction 与句内 () 语境指令）、
list_voices（39 个官方音色 + 已复刻音色查询）、clone_voice（5–10 秒参考音频复刻音色）。
附带桌面工作区三个页面：快速开始、音色库、语境配方。

安装与配置：在插件中心填写后端模式（Step Plan / 开放平台）、接口地址、模型、API Key 与
输出目录；Key 由宿主保管。保存后重启会话生效。卸载只移除资源，不停止已完成合成。

依赖与边界：运行时仅需 Node.js 20+；市场安装不执行 npm install（自包含单文件分发）。
使用外部模型服务会上传文本并消耗额度；计费按所配置渠道，不随聊天账户切换。
可选本地 WebUI 工作台为开发计划（0.3.0），不随本版本提供。
```

## 五、PR 正文要点（给维护者）

- 用户得到什么：三个 MCP 工具 + 桌面工作区三页 + 插件中心声明式配置。
- 来源与提交：独立仓库 + 固定 40 位 SHA + 资源路径（仓库根）。
- 依赖：运行时零 npm 依赖（自包含 bundle + 许可证归集）；仅需 Node.js 20+。
- 已验证：60 个单元/端到端测试（含托管布局下 dist 产物全链验证）、stdio 冒烟、构建确定性。
- 未验证（如实声明）：真实 DFSC 宿主安装验收、真实 Step Plan/API Key 下的合成与复刻计费——按验收门完成后再合入或单独记录。
- 风险披露：上传文本至所选模型渠道并产生费用；音色复刻按次收费（9.9 元/音色）；无遥测。
