#!/usr/bin/env node
/**
 * 真实 API 端到端验证：用最小文本调用阶跃真实 TTS 接口。
 *
 * 经过插件自己的 StepAudioClient（与 MCP server 同一条代码路径），
 * 但不经过 MCP 协议层——隔离验证“client → 真实 api.stepfun.com”。
 *
 * Key 只从环境变量读取：不经过聊天、不写入任何文件、不出现在输出里。
 * 用法：
 *   STEP_API_KEY=<your-key> node scripts/verify-real-api.mjs
 * 可选环境变量：STEPAUDIO_MODEL / STEPAUDIO_VOICE / STEPAUDIO_BASE_URL
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StepAudioClient } from '../src/client.js';

const key = process.env.STEP_API_KEY ?? process.env.STEPFUN_API_KEY;
if (!key) {
  console.error('请先设置环境变量 STEP_API_KEY（或 STEPFUN_API_KEY）。');
  process.exit(1);
}

const baseUrl = (process.env.STEPAUDIO_BASE_URL ?? 'https://api.stepfun.com/v1').replace(/\/+$/, '');
const model = process.env.STEPAUDIO_MODEL ?? 'stepaudio-2.5-tts';
const voice = process.env.STEPAUDIO_VOICE ?? 'cixingnansheng';
const text = '真实验证：智能阶跃，十倍每一个人的可能。';

const client = new StepAudioClient({ baseUrl, apiKey: key });
const startedAt = Date.now();

let result;
try {
  result = await client.createSpeech({ model, voice, input: text, response_format: 'mp3' });
} catch (error) {
  console.error(`✖ 调用失败（${Date.now() - startedAt}ms）：${error.message}`);
  if (error.details?.body) console.error(`上游响应：${error.details.body}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startedAt;
const outFile = path.join(process.cwd(), `verify-real-${model}.mp3`);
await fs.writeFile(outFile, result.buffer);

console.log(`✔ 合成成功（${elapsedMs}ms）`);
console.log(`  模型：${model} | 音色：${voice} | 文本：${text.length} 字符`);
console.log(`  音频：${result.buffer.length} 字节 → ${outFile}`);
console.log('  请播放该文件，确认音色、内容与计费是否符合预期。');
