import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 社区市场 dfsc.plugin.json 分类词表（CONTRIBUTING.md，2026-11）。 */
const CATEGORY_VOCABULARY = [
  'development',
  'research',
  'text-documents',
  'knowledge',
  'audio-video',
  'image-design',
  'automation',
  'themes',
];

const CONTROL_CHARS = /[\u0000-\u001F]/;

test('step.plugin.json 符合社区 MCP 插件契约', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, 'step.plugin.json'), 'utf8'));

  assert.equal(manifest.id, 'dfsc-stepaudio');
  assert.ok(typeof manifest.name === 'string' && manifest.name !== '');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(typeof manifest.description === 'string' && manifest.description !== '');
  assert.ok(await fileExists(path.join(PLUGIN_ROOT, manifest.icon)), 'icon 文件存在');

  const server = manifest.mcpServers?.stepaudio;
  assert.ok(server, '声明 mcpServers.stepaudio');
  assert.equal(server.command, 'node');
  assert.ok(Array.isArray(server.args) && server.args.length > 0);
  assert.ok(
    await fileExists(path.join(PLUGIN_ROOT, server.args[0])),
    `入口文件存在：${server.args[0]}（缺失请先 npm run build）`,
  );
  assert.equal(server.env.STEPFUN_API_KEY, 'stepaudio-managed-provider-context');
  assert.ok(server.startup_timeout_sec > 0 && server.tool_timeout_sec > 0);
});

test('dfsc.plugin.json 分类与关键词契约', async () => {
  const raw = await fs.readFile(path.join(PLUGIN_ROOT, 'dfsc.plugin.json'), 'utf8');
  assert.ok(raw.length <= 64 * 1024, '文件不超过 64 KiB');
  const declaration = JSON.parse(raw);

  assert.equal(declaration.schemaVersion, 1);
  assert.ok(declaration.categories.length >= 1 && declaration.categories.length <= 3);
  for (const category of declaration.categories) {
    assert.ok(CATEGORY_VOCABULARY.includes(category), `分类 ID 在词表内：${category}`);
  }
  assert.ok(declaration.keywords.length <= 5);
  for (const keyword of declaration.keywords) {
    assert.ok(keyword.trim() === keyword && keyword !== '', `关键词去空白后非空：${keyword}`);
    assert.ok([...keyword].length <= 48, `关键词不超过 48 个 UTF-16 码元：${keyword}`);
    assert.ok(!CONTROL_CHARS.test(keyword), `关键词不含控制字符：${keyword}`);
  }
  assert.equal(new Set(declaration.keywords).size, declaration.keywords.length, '关键词不重复');
  assert.ok(declaration.locales?.zh?.description, '有中文描述');
  assert.ok(declaration.locales?.en?.description, '有英文描述');
});

test('dfsc.plugin.json requirements 契约（宿主 schema：作者声明的准备项）', async () => {
  const declaration = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, 'dfsc.plugin.json'), 'utf8'));

  // 宿主 schema additionalProperties:false 的顶层白名单
  const ALLOWED_TOP_LEVEL = [
    '$schema',
    'schemaVersion',
    'authors',
    'maintainers',
    'license',
    'categories',
    'keywords',
    'documentation',
    'desktop',
    'requirements',
    'locales',
    'tutorials',
    'links',
  ];
  for (const key of Object.keys(declaration)) {
    assert.ok(ALLOWED_TOP_LEVEL.includes(key), `顶层字段在宿主 schema 白名单内：${key}`);
  }

  const { requirements } = declaration;
  assert.ok(requirements, '声明 requirements');
  // requirements.dfsc 需是 semver 范围；未通过真实宿主验收前不声明
  if (requirements.dfsc !== undefined) {
    assert.match(requirements.dfsc, /^\d+\.\d+\.\d+(?:[-+].*)?(?:\s+(?:>=|<=|>|<|=|\^|~)\s*\d+\.\d+\.\d+(?:[-+].*)?)*$/, 'dfsc 为语义化版本范围');
  }
  assert.ok(Array.isArray(requirements.external) && requirements.external.length > 0, '声明外部准备项');
  assert.ok(requirements.external.length <= 12, '外部准备项不超过 12');
  for (const item of requirements.external) {
    assert.ok(typeof item.name === 'string' && item.name.trim() !== '', '准备项 name 非空');
    if (item.description !== undefined) {
      assert.ok(item.description.length <= 512, '准备项 description 不超过 512 字符');
      assert.ok(!CONTROL_CHARS.test(item.description), '准备项 description 不含控制字符');
    }
    if (item.url !== undefined) {
      assert.match(item.url, /^https:\/\/[^/@?#]+(?:[/?#]|$)/, '准备项 url 为无凭据 HTTPS');
    }
    if (item.optional !== undefined) assert.equal(typeof item.optional, 'boolean', 'optional 为布尔');
  }
  // 运行时不声明 desktop 工作区
  assert.ok(requirements.external.some((item) => /Node\.js/.test(item.name)), '声明 Node.js 运行环境');
});

test('provider.example 是占位模板且不含真实凭据', async () => {
  const example = await fs.readFile(path.join(PLUGIN_ROOT, 'provider.example'), 'utf8');
  assert.ok(example.includes('REPLACE_WITH_YOUR_KEY'), 'Key 为占位符');
  assert.ok(example.includes('STEP_API_KEY'), '说明 Key 变量名');
});

async function fileExists(filePath) {
  try {
    const info = await fs.stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}
