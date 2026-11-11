#!/usr/bin/env node
/**
 * 从 data/system-voices.json 生成桌面工作区页面 docs/voices.md。
 * 音色数据以官方为准，页面不手抄，避免条目错误。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'data', 'system-voices.json'), 'utf8'));

const GROUPS = [
  { name: '有声书与情感陪伴', match: (scene) => scene.includes('有声书') },
  { name: '口播与新闻', match: (scene) => scene.includes('口播') },
  { name: '客服与业务办理', match: (scene) => scene.includes('客服') },
  { name: '视频配音', match: (scene) => scene.includes('视频配音') },
  { name: '营销与教育', match: (scene) => scene.includes('营销') || scene.includes('教育') },
  { name: '英文音色', match: (_scene, description) => description.includes('英文') },
];

const details = catalog['voices-details'];
const entries = catalog.voices.map((id) => {
  const detail = details[id];
  return {
    id,
    name: detail?.['voice-name'] ?? '',
    description: detail?.['voice-description'] ?? '',
    scene: detail?.recommended_scene ?? '',
  };
});

const buckets = new Map(GROUPS.map((group) => [group.name, []]));
const ungrouped = [];
for (const entry of entries) {
  const group = GROUPS.find((candidate) => candidate.match(entry.scene, entry.description));
  if (group) buckets.get(group.name).push(entry);
  else ungrouped.push(entry);
}

const lines = [];
lines.push('# 音色库');
lines.push('');
lines.push(`阶跃 StepAudio 官方音色共 **${entries.length} 个**（${entries.length - 2} 个有官方名称与描述，2 个官方未提供详情）。按推荐场景分组，同一音色只出现在第一个命中的分组；完整 ID 列表见文末索引。`);
lines.push('');
lines.push('**怎么试听**：直接让 Agent 念样本，例如“用磁性男声念一句：智能阶跃，十倍每一个人的可能”；或打开[官方 Demo](https://stepaudiollm.github.io/step-audio-2.5-tts/)逐个听。选定后把音色 ID 告诉 Agent 即可。');
lines.push('');
lines.push('**注意**：音色数量与详情以实时接口为准（`list_voices` 工具），本页为内置目录快照。');
lines.push('');

for (const group of GROUPS) {
  const members = buckets.get(group.name);
  if (members.length === 0) continue;
  lines.push(`## ${group.name}`);
  lines.push('');
  for (const entry of members) {
    const label = entry.name ? `**${entry.name}**` : '（官方未提供名称）';
    const description = entry.description ? `——${entry.description}` : '';
    lines.push(`- ${label}（\`${entry.id}\`）${description}。适合：${entry.scene || '官方未提供'}`);
  }
  lines.push('');
}

if (ungrouped.length > 0) {
  lines.push('## 其他');
  lines.push('');
  for (const entry of ungrouped) {
    lines.push(`- **${entry.name || '（官方未提供名称）'}**（\`${entry.id}\`）${entry.description ? `——${entry.description}` : ''}。适合：${entry.scene || '官方未提供'}`);
  }
  lines.push('');
}

lines.push('## ID 索引');
lines.push('');
lines.push('| 音色 ID | 名称 |');
lines.push('| --- | --- |');
for (const entry of entries) {
  lines.push(`| \`${entry.id}\` | ${entry.name || '—'} |`);
}
lines.push('');

await writeFile(path.join(root, 'docs', 'voices.md'), `${lines.join('\n')}\n`, 'utf8');
console.log(`docs/voices.md 已生成：${entries.length} 个音色，${GROUPS.filter((g) => buckets.get(g.name).length > 0).length} 个分组`);
