'use strict';
// Slave "Sync" step: the master's general OBS settings (canvas, FPS, colour,
// audio) copied into this PC's OBS through the WebSocket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeObs } = require('../src/fake-obs');
const S = require('../src/obs-settings');

const quiet = { info() {}, warn() {}, error() {} };

function master() {
  const m = new FakeObs();
  m.profile.video = { baseWidth: 3840, baseHeight: 1080, outputWidth: 3840, outputHeight: 1080, fpsNumerator: 50, fpsDenominator: 1 };
  m.profile.params['Video.ColorFormat'] = 'P010';
  m.profile.params['Audio.SampleRate'] = '44100';
  return m;
}

test('the slave takes the canvas, FPS, colour and audio settings', async () => {
  const m = master(), s = new FakeObs();
  const r = await S.apply(s, await S.read(m), quiet);
  assert.equal(r.error, null);
  assert.deepEqual(s.profile.video, m.profile.video);
  assert.equal(s.profile.params['Video.ColorFormat'], 'P010');
  assert.equal(s.profile.params['Audio.SampleRate'], '44100');
  assert.equal(r.restart, true);                       // audio: at the next OBS start
  assert.ok(r.changed.includes('canvas 3840x1080'));
  assert.ok(r.changed.includes('50 fps'));
  // again: nothing to do
  const again = await S.apply(s, await S.read(m), quiet);
  assert.deepEqual(again.changed, []);
});

test('a value back to default on the master is reset on the slave', async () => {
  const m = new FakeObs(), s = new FakeObs();
  delete m.profile.params['Video.ColorSpace'];           // default 709
  s.profile.params['Video.ColorSpace'] = '2100PQ';
  const r = await S.apply(s, await S.read(m), quiet);
  assert.ok(r.changed.some(c => c.startsWith('colour space')));
  assert.equal(s.profile.params['Video.ColorSpace'], undefined);
});

test('an output on: video left alone and said, audio still written', async () => {
  const m = master(), s = new FakeObs();
  s.outputActive = true;
  const r = await S.apply(s, await S.read(m), quiet);
  assert.match(r.error, /output is on/);
  assert.equal(s.profile.video.baseWidth, 1920);
  assert.equal(s.profile.params['Video.ColorFormat'], 'NV12');   // not half-applied
  assert.equal(s.profile.params['Audio.SampleRate'], '44100');
});

test('fractional FPS compare and show right', () => {
  const v = (n, d) => ({ video: { baseWidth: 1, baseHeight: 1, outputWidth: 1, outputHeight: 1, fpsNumerator: n, fpsDenominator: d }, params: [] });
  assert.deepEqual(S.diff(v(60, 1), v(120, 2)), []);
  assert.equal(S.diff(v(30000, 1001), v(30, 1))[0].label, '29.97 fps');
});

test('the FPS keeps the master\'s way of being set (Common FPS Values, not a fraction)', async () => {
  const m = new FakeObs(), s = new FakeObs();
  m.profile.video.fpsNumerator = 50;
  Object.assign(m.profile.params, { 'Video.FPSType': '0', 'Video.FPSCommon': '50' });
  const r = await S.apply(s, await S.read(m), quiet);
  assert.equal(r.error, null);
  assert.equal(s.profile.video.fpsNumerator, 50);
  assert.equal(s.profile.params['Video.FPSType'], '0');      // not left at 2 (fraction) by SetVideoSettings
  assert.equal(s.profile.params['Video.FPSCommon'], '50');
  assert.deepEqual((await S.apply(s, await S.read(m), quiet)).changed, []);   // stable
});
