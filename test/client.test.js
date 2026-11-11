import test from 'node:test';
import assert from 'node:assert/strict';
import { StepAudioClient } from '../src/client.js';
import { McpToolError } from '../src/lib/errors.js';

const CONFIG = { baseUrl: 'https://api.test/v1', apiKey: 'secret-key' };

const originalFetch = globalThis.fetch;
let calls;

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

test.beforeEach(() => {
  calls = [];
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('createSpeech 二进制模式：POST /audio/speech，带 Bearer 头，返回 Buffer', async () => {
  mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const client = new StepAudioClient(CONFIG);
  const result = await client.createSpeech({ model: 'stepaudio-2.5-tts', voice: 'v', input: 'hi' });

  assert.equal(result.kind, 'binary');
  assert.deepEqual([...result.buffer], [1, 2, 3]);
  assert.equal(calls[0].url, 'https://api.test/v1/audio/speech');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'stepaudio-2.5-tts',
    voice: 'v',
    input: 'hi',
    return_url: false,
  });
});

test('createSpeech return_url 模式解析 JSON', async () => {
  mockFetch(() => jsonResponse({ data: { url: 'https://f/1.mp3', subtitles: [{ text: 'hi' }] } }));
  const client = new StepAudioClient(CONFIG);
  const result = await client.createSpeech({ input: 'hi', voice: 'v', return_url: true });
  assert.equal(result.kind, 'url');
  assert.equal(result.url, 'https://f/1.mp3');
  assert.equal(result.subtitles.length, 1);
});

test('systemVoices 带 model query', async () => {
  mockFetch(() => jsonResponse({ voices: ['a'], 'voices-details': {} }));
  const client = new StepAudioClient(CONFIG);
  const result = await client.systemVoices('step-tts-2');
  assert.equal(calls[0].url, 'https://api.test/v1/audio/system_voices?model=step-tts-2');
  assert.deepEqual(result.voices, ['a']);
});

test('listClonedVoices 带分页参数', async () => {
  mockFetch(() => jsonResponse({ object: 'list', data: [] }));
  const client = new StepAudioClient(CONFIG);
  await client.listClonedVoices({ limit: 5, order: 'asc' });
  assert.equal(calls[0].url, 'https://api.test/v1/audio/voices?limit=5&order=asc');
});

test('createVoice 发送 model/file_id/text', async () => {
  mockFetch(() => jsonResponse({ id: 'voice-tone-1' }));
  const client = new StepAudioClient(CONFIG);
  const result = await client.createVoice({ model: 'step-tts-2', file_id: 'file-1', text: '文本' });
  assert.equal(result.id, 'voice-tone-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'step-tts-2', file_id: 'file-1', text: '文本' });
});

test('uploadFile 用 multipart FormData', async () => {
  mockFetch(() => jsonResponse({ id: 'file-9' }));
  const client = new StepAudioClient(CONFIG);
  const result = await client.uploadFile('package.json'); // 仅借用本仓库文件做载体
  assert.equal(result.id, 'file-9');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('purpose'), 'storage');
});

test('上游非 2xx 包装为 UPSTREAM_HTTP_ERROR，不泄露 key', async () => {
  mockFetch(() => new Response('bad request detail', { status: 400 }));
  const client = new StepAudioClient(CONFIG);
  await assert.rejects(
    () => client.createSpeech({ input: 'x', voice: 'v' }),
    (error) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'UPSTREAM_HTTP_ERROR');
      assert.equal(error.details.status, 400);
      assert.ok(!error.message.includes('secret-key'));
      return true;
    },
  );
});

test('网络错误包装为 UPSTREAM_NETWORK_ERROR', async () => {
  mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const client = new StepAudioClient(CONFIG);
  await assert.rejects(
    () => client.systemVoices(),
    (error) => error instanceof McpToolError && error.code === 'UPSTREAM_NETWORK_ERROR',
  );
});
