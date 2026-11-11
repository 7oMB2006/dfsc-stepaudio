import { promises as fs } from 'node:fs';
import path from 'node:path';
import { apiError, McpToolError, networkError } from './lib/errors.js';

/**
 * 阶跃 StepAudio TTS API 客户端（OpenAI 兼容形态）。
 * base URL 由 config 决定：Step Plan（/step_plan/v1）或开放平台/任意兼容服务（/v1）。
 * 鉴权统一 Bearer key；本类不打印、不返回任何密钥信息。
 */
export class StepAudioClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  async #request(operation, url, { method = 'GET', json, binary = false, form } = {}) {
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    let body;
    if (form) {
      body = form; // FormData 自带 multipart boundary
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }

    let response;
    try {
      response = await fetch(url, { method, headers, body });
    } catch (cause) {
      throw networkError(operation, cause);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw apiError(operation, response, text);
    }
    if (binary) return Buffer.from(await response.arrayBuffer());

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new McpToolError(`${operation} 失败：上游返回了无法解析的响应`, {
        code: 'UPSTREAM_BAD_RESPONSE',
        details: { snippet: text.slice(0, 200) },
      });
    }
  }

  /**
   * 语音合成。
   * @returns {Promise<{kind: 'binary'|'url', buffer?: Buffer, url?: string, subtitles?: unknown[]}>}
   */
  async createSpeech(params) {
    const { return_url: returnUrl = false, ...rest } = params;
    const result = await this.#request('语音合成', `${this.baseUrl}/audio/speech`, {
      method: 'POST',
      json: { ...rest, return_url: returnUrl },
      binary: !returnUrl,
    });
    if (returnUrl) {
      return { kind: 'url', url: result?.data?.url, subtitles: result?.data?.subtitles ?? [] };
    }
    return { kind: 'binary', buffer: result };
  }

  /** 官方音色详情（文档标注当前仅支持 model=step-tts-2）。 */
  async systemVoices(model = 'step-tts-2') {
    const url = `${this.baseUrl}/audio/system_voices?model=${encodeURIComponent(model)}`;
    return this.#request('获取官方音色', url);
  }

  /** 已复刻音色列表。 */
  async listClonedVoices({ limit = 20, order = 'desc' } = {}) {
    const url = `${this.baseUrl}/audio/voices?limit=${encodeURIComponent(limit)}&order=${encodeURIComponent(order)}`;
    return this.#request('查询已复刻音色', url);
  }

  /** 正式复刻音色，返回 { id, duplicated? }。 */
  async createVoice({ model, file_id: fileId, text }) {
    return this.#request('音色复刻', `${this.baseUrl}/audio/voices`, {
      method: 'POST',
      json: { model, file_id: fileId, ...(text ? { text } : {}) },
    });
  }

  /** 复刻试听，返回 { sample_text, sample_audio(base64), request_id }。 */
  async previewVoice(params) {
    return this.#request('复刻试听', `${this.baseUrl}/audio/voices/preview`, {
      method: 'POST',
      json: params,
    });
  }

  /** 上传参考音频（purpose=storage，mp3/wav，复刻用 5–10 秒），返回 File 对象。 */
  async uploadFile(filePath, purpose = 'storage') {
    const buffer = await fs.readFile(filePath);
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', new Blob([buffer]), path.basename(filePath));
    return this.#request('上传参考音频', `${this.baseUrl}/files`, { method: 'POST', form });
  }
}
