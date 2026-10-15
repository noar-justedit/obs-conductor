'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileDuration, inputFile } = require('../src/media-duration');

const box = (type, body) => {
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const mvhd0 = (ts, dur) => { const b = Buffer.alloc(100); b.writeUInt32BE(ts, 12); b.writeUInt32BE(dur, 16); return box('mvhd', b); };
const mvhd1 = (ts, dur) => { const b = Buffer.alloc(112); b[0] = 1; b.writeUInt32BE(ts, 20); b.writeBigUInt64BE(BigInt(dur), 24); return box('mvhd', b); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-'));
const write = (name, ...parts) => { const f = path.join(tmp, name); fs.writeFileSync(f, Buffer.concat(parts)); return f; };

test('moov after the media (ProRes from editors / cameras)', () => {
  const f = write('a.mov', box('ftyp', Buffer.from('qt  ')), box('mdat', Buffer.alloc(5000)), box('moov', mvhd0(600, 4488)));
  assert.strictEqual(fileDuration(f), 7.48);
});

test('version 1 header, 64-bit media size', () => {
  const big = Buffer.alloc(16); big.writeUInt32BE(1, 0); big.write('mdat', 4, 'latin1'); big.writeBigUInt64BE(16n + 100n, 8);
  const f = write('b.mp4', box('ftyp', Buffer.from('isom')), big, Buffer.alloc(100), box('moov', Buffer.concat([box('udta', Buffer.alloc(4)), mvhd1(90000, 90000 * 12)])));
  assert.strictEqual(fileDuration(f), 12);
});

test('unknown cases give null', () => {
  assert.strictEqual(fileDuration(write('c.mov', box('ftyp', Buffer.from('qt  ')))), null);       // no moov
  assert.strictEqual(fileDuration(write('d.mov', box('moov', mvhd0(600, 0)))), null);            // fragmented
  assert.strictEqual(fileDuration(write('e.mkv', Buffer.alloc(50))), null);                       // other container
  assert.strictEqual(fileDuration(path.join(tmp, 'missing.mov')), null);
});

test('file of an OBS input', () => {
  assert.strictEqual(inputFile('ffmpeg_source', { local_file: 'D:/a.mov' }), 'D:/a.mov');
  assert.strictEqual(inputFile('ffmpeg_source', { is_local_file: false, input: 'rtmp://x' }), null);
  assert.strictEqual(inputFile('vlc_source', { playlist: [{ value: 'D:/a.mov', hidden: false }] }), 'D:/a.mov');
  assert.strictEqual(inputFile('vlc_source', { playlist: [{ value: 'a' }, { value: 'b' }] }), null);
});
