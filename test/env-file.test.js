import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile } from '../src/lib/env-file.js';

test('解析键值对，忽略空行与 # 注释', () => {
  const settings = parseEnvFile(
    ['# 注释', '', 'STEP_API_KEY=abc123', '  STEPAUDIO_MODEL = step-tts-2  ', 'NO_EQUALS_LINE', '=novalue'].join('\n'),
  );
  assert.deepEqual(settings, { STEP_API_KEY: 'abc123', STEPAUDIO_MODEL: 'step-tts-2' });
});

test('成对引号被剥掉，值中的等号保留', () => {
  const settings = parseEnvFile(['A="quoted value"', "B='single'", 'C=k=v', 'D='].join('\n'));
  assert.equal(settings.A, 'quoted value');
  assert.equal(settings.B, 'single');
  assert.equal(settings.C, 'k=v');
  assert.equal(settings.D, '');
});

test('后写的键覆盖先写的；CRLF 行尾可解析', () => {
  const settings = parseEnvFile('K=first\r\nK=second\r\n');
  assert.equal(settings.K, 'second');
});
