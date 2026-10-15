'use strict';
// Unit tests for the slave side (src/follower.js), against simulated OBS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MasterFollower } = require('../src/follower');
const { FakeObs } = require('../src/fake-obs');

const quiet = { info() {}, warn() {}, error() {} };
function make() {
  const f = new MasterFollower(() => ({ enabled: true }), new FakeObs(null, null), quiet, { autoStart: false });
  f.master = new FakeObs(null, null);
  return f;
}

test('follows a scene change with the master transition', async () => {
  const f = make();
  f.master.transition = 'Swipe'; f.master.transitionMs = 900;
  await f.onEvent('CurrentProgramSceneChanged', { sceneName: 'Ad Break' });
  assert.equal(f.local.current, 'Ad Break');
  assert.deepEqual(f.local.switchLog.at(-1), ['Ad Break', 'Swipe', 900]);
});

test('nothing to do when already on the scene', async () => {
  const f = make();
  f.local.current = 'Interview';
  await f.onEvent('CurrentProgramSceneChanged', { sceneName: 'Interview' });
  assert.equal(f.local.switchLog.length, 0);
});

test('unknown scene is reported', async () => {
  const f = make();
  await f.onEvent('CurrentProgramSceneChanged', { sceneName: 'Not synced' });
  assert.match(f.error, /Not synced/);
});

test('media actions are replayed, others ignored', async () => {
  const f = make();
  await f.onEvent('MediaInputActionTriggered', { inputName: 'Ad reel', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
  await f.onEvent('MediaInputActionTriggered', { inputName: 'Ad reel', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE' });
  assert.deepEqual(f.local.mediaLog, [['Ad reel', 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART']]);
});

test('drift is corrected with the master transition', async () => {
  const f = make();
  f.master.transition = 'Swipe'; f.master.transitionMs = 900;
  f.master.current = 'Sponsor Loop'; f.local.current = 'Live Cam';
  await f.checkDrift();
  assert.deepEqual(f.local.switchLog.at(-1), ['Sponsor Loop', 'Swipe', 900]);
  assert.equal(f.local.transition, 'Swipe');
});

test('a missing scene leaves the slave on the master transition, never a Cut', async () => {
  const f = make();
  f.master.transition = 'Fade'; f.master.transitionMs = 500;
  f.master.current = 'Not synced'; f.local.current = 'Live Cam';
  await f.checkDrift();
  assert.equal(f.local.current, 'Live Cam');
  assert.equal(f.local.transition, 'Fade');
  assert.equal(f.local.transitionMs, 500);
});

test('no drift correction right after following a change', async () => {
  const f = make();
  f.lastEventAt = Date.now();
  f.master.current = 'Sponsor Loop'; f.local.current = 'Live Cam';
  await f.checkDrift();
  assert.equal(f.local.switchLog.length, 0);
});
