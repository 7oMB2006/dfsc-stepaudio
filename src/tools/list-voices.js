import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanParams, textResult } from './shared.js';

const CATALOG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'system-voices.json',
);

async function loadLocalCatalog() {
  const raw = await fs.readFile(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.voices.map((id) => ({
    id,
    name: parsed['voices-details']?.[id]?.['voice-name'] ?? '',
    description: parsed['voices-details']?.[id]?.['voice-description'] ?? '',
    scene: parsed['voices-details']?.[id]?.recommended_scene ?? '',
  }));
}

async function listOfficial(client) {
  try {
    const result = await client.systemVoices('step-tts-2');
    const details = result['voices-details'] ?? {};
    return {
      source: 'api',
      voices: result.voices.map((id) => ({
        id,
        name: details[id]?.['voice-name'] ?? '',
        description: details[id]?.['voice-description'] ?? '',
        scene: details[id]?.recommended_scene ?? '',
      })),
    };
  } catch {
    // 官方接口不可用（如当前模型不支持该系统查询）时，用内置目录兜底
    return { source: 'local-catalog', voices: await loadLocalCatalog() };
  }
}

async function listCloned(client, { limit, order }) {
  const result = await client.listClonedVoices({ limit, order });
  return { source: 'api', voices: result.data ?? [] };
}

export const definition = {
  name: 'list_voices',
  description:
    '列出可用音色：官方音色（含名称/描述/推荐场景）和已复刻音色。官方音色优先走上游接口，不可用时回退到内置目录。',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['official', 'cloned', 'all'],
        description: 'official=仅官方音色（默认）；cloned=仅已复刻音色；all=两者。',
      },
      limit: { type: 'integer', description: '已复刻音色分页数量，1~100，默认 20。' },
      order: { type: 'string', enum: ['asc', 'desc'], description: '已复刻音色按创建时间排序，默认 desc。' },
    },
  },
};

export async function handler(args, ctx) {
  const { client } = ctx;
  const scope = args.scope ?? 'official';
  const page = cleanParams({ limit: args.limit, order: args.order });

  if (scope === 'cloned') {
    return textResult({ cloned: await listCloned(client, page) });
  }
  if (scope === 'all') {
    const [official, cloned] = await Promise.all([
      listOfficial(client),
      listCloned(client, page).catch((error) => ({ source: 'error', error: error.message })),
    ]);
    return textResult({ official, cloned });
  }
  return textResult({ official: await listOfficial(client) });
}
