#!/usr/bin/env node
/**
 * 生成插件图标 icon.png（512x512，零依赖）。
 * 图案：深色圆角方块 + 音频波形条（青→紫渐变）。确定性输出，可重复运行。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const OUTPUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'icon.png');

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘图 ----------

function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

const coverage = (d) => Math.min(Math.max(0.5 - d, 0), 1);

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const BG_TOP_LEFT = [34, 52, 107];
const BG_BOTTOM_RIGHT = [12, 19, 38];
const BAR_LEFT = [61, 224, 195];
const BAR_RIGHT = [139, 124, 246];

const BARS = [110, 185, 245, 265, 245, 185, 110];
const BAR_WIDTH = 40;
const BAR_GAP = 22;
const BAR_RADIUS = 20;
const BARS_TOTAL = BARS.length * BAR_WIDTH + (BARS.length - 1) * BAR_GAP;
const BARS_START = (SIZE - BARS_TOTAL) / 2;
const CENTER = SIZE / 2;

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const bgDistance = sdRoundBox(x, y, CENTER, CENTER, CENTER - 112, CENTER - 112, 112);
      const bgAlpha = coverage(bgDistance);
      if (bgAlpha <= 0) continue; // 保持透明

      const gradient = (x + y) / (SIZE * 2);
      let color = mix(BG_TOP_LEFT, BG_BOTTOM_RIGHT, gradient);

      for (let index = 0; index < BARS.length; index += 1) {
        const barX = BARS_START + index * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2;
        const barY = CENTER;
        const barDistance = sdRoundBox(x, y, barX, barY, BAR_WIDTH / 2, BARS[index] / 2, BAR_RADIUS);
        const barAlpha = coverage(barDistance) * bgAlpha; // 裁剪在圆角背景内，边缘抗锯齿
        if (barAlpha <= 0) continue;
        const barColor = mix(BAR_LEFT, BAR_RIGHT, index / (BARS.length - 1));
        // 条与背景按覆盖率混合（抗锯齿边缘）
        const t = barAlpha;
        color = [
          Math.round(color[0] + (barColor[0] - color[0]) * t),
          Math.round(color[1] + (barColor[1] - color[1]) * t),
          Math.round(color[2] + (barColor[2] - color[2]) * t),
        ];
      }

      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = Math.round(bgAlpha * 255);
    }
  }
  return rgba;
}

const png = encodePng(SIZE, SIZE, render());
await fs.writeFile(OUTPUT, png);
process.stdout.write(`已生成 ${OUTPUT}（${SIZE}x${SIZE}, ${png.length} 字节）\n`);
