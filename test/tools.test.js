import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tts from '../src/tools/text-to-speech.js';
import * as listVoices from '../src/tools/list-voices.js';
import * as cloneVoice from '../src/tools/clone-voice.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let outputDir;

test.before(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-stepaudio-test-'));
});

test.after(async () => {
  await fs.rm(outputDir, { recursive: true, force: true });
});

function makeCtx(overrides = {}) {
  const client = {
    calls: [],
    async createSpeech(params) {
      this.calls.push(['createSpeech', params]);
      return overrides.speech ?? { kind: 'binary', buffer: Buffer.from('AUDIO') };
    },
    async systemVoices(model) {
      this.calls.push(['systemVoices', model]);
      if (overrides.systemVoicesError) throw new Error('boom');
      return (
        overrides.systemVoices ?? {
          voices: ['cixingnansheng'],
          'voices-details': {
            cixingnansheng: { 'voice-name': '磁性男声', 'voice-description': '男声', recommended_scene: '有声书' },
          },
        }
      );
    },
    async listClonedVoices(query) {
      this.calls.push(['listClonedVoices', query]);
      return { data: [{ id: 'voice-1', file_id: 'file-1', created_at: 1 }] };
    },
    async createVoice(body) {
      this.calls.push(['createVoice', body]);
      return { id: 'voice-new', duplicated: false };
    },
    async previewVoice(body) {
      this.calls.push(['previewVoice', body]);
      return { sample_text: body.sample_text, sample_audio: Buffer.from('WAVDATA').toString('base64'), request_id: 'r1' };
    },
    async uploadFile(filePath) {
      this.calls.push(['uploadFile', filePath]);
      return { id: 'file-up' };
    },
  };
  return {
    client,
    ctx: {
      client,
      config: {
        mode: 'stepplan',
        baseUrl: 'https://api.test/v1',
        apiKey: 'k',
        model: 'stepaudio-2.5-tts',
        outputDir,
        pluginRoot: PLUGIN_ROOT,
      },
    },
  };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

// ---------- text_to_speech ----------

test('text_to_speech 合成并落盘，返回文件路径与元数据', async () => {
  const { ctx, client } = makeCtx();
  const result = await tts.handler({ text: '你好', voice: 'cixingnansheng' }, ctx);
  const payload = payloadOf(result);

  assert.equal(payload.kind, 'file');
  assert.match(payload.file, new RegExp(`^${outputDir.replace(/\\/g, '\\\\')}`));
  assert.equal(payload.bytes, 5);
  assert.equal(payload.model, 'stepaudio-2.5-tts');
  assert.equal(payload.response_format, 'mp3');

  const [, params] = client.calls[0];
  assert.equal(params.input, '你好');
  assert.equal(params.voice, 'cixingnansheng');
  assert.equal(params.return_url, false);

  await fs.access(payload.file);
});

test('text_to_speech 支持 output_path 覆盖', async () => {
  const { ctx } = makeCtx();
  const target = path.join(outputDir, 'custom.wav');
  const payload = payloadOf(await tts.handler({ text: 'hi', voice: 'v', output_path: target, response_format: 'wav' }, ctx));
  assert.equal(payload.file, target);
  await fs.access(target);
});

test('text_to_speech return_url 模式不落盘', async () => {
  const { ctx } = makeCtx({ speech: { kind: 'url', url: 'https://f/a.mp3', subtitles: [] } });
  const payload = payloadOf(await tts.handler({ text: 'hi', voice: 'v', return_url: true }, ctx));
  assert.equal(payload.kind, 'url');
  assert.equal(payload.url, 'https://f/a.mp3');
});

test('text_to_speech 托管安装拒绝包内 output_path（Codex 审查回归）', async () => {
  const { ctx, client } = makeCtx();
  ctx.config.managed = true;
  ctx.config.pluginRoot = PLUGIN_ROOT;
  await assert.rejects(
    () => tts.handler({ text: 'hi', voice: 'v', output_path: 'inside-package.mp3' }, ctx),
    /输出路径不能位于插件包内/,
  );
  assert.equal(client.calls.length, 0, '路径非法的请求不得发起合成');
});

test('text_to_speech 参数校验', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(() => tts.handler({ text: '  ', voice: 'v' }, ctx), /text 不能为空/);
  await assert.rejects(() => tts.handler({ text: 'x'.repeat(1001), voice: 'v' }, ctx), /上限 1000/);
  await assert.rejects(() => tts.handler({ text: 'hi', voice: '' }, ctx), /voice 不能为空/);
  await assert.rejects(
    () => tts.handler({ text: 'hi', voice: 'v', instruction: 'x'.repeat(201) }, ctx),
    /instruction 超长/,
  );
  // stepaudio-3-tts 允许 500 字符
  const ok = await tts.handler({ text: 'hi', voice: 'v', model: 'stepaudio-3-tts', instruction: 'x'.repeat(300) }, ctx);
  assert.equal(payloadOf(ok).kind, 'file');
});

// ---------- list_voices ----------

test('list_voices 官方音色走上游接口并映射字段', async () => {
  const { ctx, client } = makeCtx();
  const payload = payloadOf(await listVoices.handler({}, ctx));
  assert.equal(payload.official.source, 'api');
  assert.deepEqual(payload.official.voices[0], {
    id: 'cixingnansheng',
    name: '磁性男声',
    description: '男声',
    scene: '有声书',
  });
  assert.equal(client.calls[0][1], 'step-tts-2');
});

test('list_voices 官方接口失败时兜底内置目录', async () => {
  const { ctx } = makeCtx({ systemVoicesError: true });
  const payload = payloadOf(await listVoices.handler({}, ctx));
  assert.equal(payload.official.source, 'local-catalog');
  assert.ok(payload.official.voices.length >= 30);
  assert.ok(payload.official.voices.every((v) => typeof v.id === 'string' && v.id !== ''));
});

test('list_voices scope=cloned 与 all', async () => {
  const clonedCtx = makeCtx();
  const cloned = payloadOf(await listVoices.handler({ scope: 'cloned', limit: 5 }, clonedCtx.ctx));
  assert.equal(cloned.cloned.source, 'api');
  assert.deepEqual(cloned.cloned.voices, [{ id: 'voice-1', file_id: 'file-1', created_at: 1 }]);
  assert.deepEqual(clonedCtx.client.calls[0][1], { limit: 5, order: undefined });

  const allCtx = makeCtx();
  const all = payloadOf(await listVoices.handler({ scope: 'all' }, allCtx.ctx));
  assert.ok(all.official.voices.length > 0);
  assert.ok(all.cloned.voices.length > 0);
});

// ---------- clone_voice ----------

test('clone_voice 用 file_id 直接复刻', async () => {
  const { ctx, client } = makeCtx();
  const payload = payloadOf(await cloneVoice.handler({ file_id: 'file-1' }, ctx));
  assert.equal(payload.voice_id, 'voice-new');
  assert.equal(payload.file_id, 'file-1');
  assert.equal(payload.model, 'stepaudio-2.5-tts');
  assert.equal(payload.duplicated, false);
  const [call, body] = client.calls[0];
  assert.equal(call, 'createVoice');
  assert.equal(body.file_id, 'file-1');
});

test('clone_voice 上传本地参考音频后再复刻', async () => {
  const { ctx, client } = makeCtx();
  const audioPath = path.join(outputDir, 'ref.wav');
  await fs.writeFile(audioPath, Buffer.from('RIFFfake'));
  const payload = payloadOf(await cloneVoice.handler({ audio_path: audioPath, text: '参考文本' }, ctx));
  assert.equal(payload.voice_id, 'voice-new');
  assert.equal(payload.file_id, 'file-up');
  assert.equal(client.calls[0][0], 'uploadFile');
  assert.equal(client.calls[0][1], audioPath);
});

test('clone_voice preview=true 保存试听音频', async () => {
  const { ctx } = makeCtx();
  const payload = payloadOf(
    await cloneVoice.handler({ file_id: 'file-1', preview: true, sample_text: '今天天气不错' }, ctx),
  );
  assert.match(payload.preview_file, /\.wav$/);
  const content = await fs.readFile(payload.preview_file);
  assert.equal(content.toString(), 'WAVDATA');
});

test('list_voices 本地目录兜底从 ctx 传入的插件根读取（打包布局回归）', async () => {
  // 回归：兜底目录曾用模块相对路径计算，打包进 dist/index.js 后会指向包外。
  // 现在必须从 ctx.config.pluginRoot 读取——用一个临时根里的最小目录验证。
  const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dfsc-stepaudio-catalog-'));
  await fs.mkdir(path.join(fakeRoot, 'data'), { recursive: true });
  await fs.writeFile(
    path.join(fakeRoot, 'data', 'system-voices.json'),
    JSON.stringify({ voices: ['fake-voice'], 'voices-details': { 'fake-voice': { 'voice-name': '假音色' } } }),
  );
  const { ctx } = makeCtx({ systemVoicesError: true });
  ctx.config.pluginRoot = fakeRoot;
  const payload = payloadOf(await listVoices.handler({}, ctx));
  assert.equal(payload.official.source, 'local-catalog');
  assert.deepEqual(payload.official.voices, [{ id: 'fake-voice', name: '假音色', description: '', scene: '' }]);
  await fs.rm(fakeRoot, { recursive: true, force: true });
});

test('clone_voice 参数校验', async () => {
  const { ctx, client } = makeCtx();
  await assert.rejects(
    () => cloneVoice.handler({ audio_path: 'a.wav', file_id: 'file-1' }, ctx),
    /只能提供一个/,
  );
  await assert.rejects(() => cloneVoice.handler({}, ctx), /必须提供/);

  const badExt = path.join(outputDir, 'ref.txt');
  await fs.writeFile(badExt, 'x');
  await assert.rejects(() => cloneVoice.handler({ audio_path: badExt }, ctx), /不支持的参考音频格式/);
  await assert.rejects(
    () => cloneVoice.handler({ audio_path: path.join(outputDir, 'nope.wav') }, ctx),
    /参考音频不存在/,
  );
  await assert.rejects(
    () => cloneVoice.handler({ file_id: 'file-1', preview: true }, ctx),
    /sample_text/,
  );
  // Codex 审查回归：preview 参数非法的请求不得先上传/创建（付费）再报错
  assert.equal(client.calls.length, 0, 'preview 参数非法的请求不得产生上传或创建调用');
});
