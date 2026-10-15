'use strict';
// Slave losing its master: notification + fallback scene, then back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Companion } = require('../src/main');
const { Notes } = require('../src/tray');
const { FakeObs } = require('../src/fake-obs');

function fakeSlave() {
  const obs = new FakeObs(); obs.current = 'Live Cam';
  const self = {
    store: { slaveConfig: () => ({ enabled: true, master_host: '10.0.0.5', master_name: 'REGIE', fallback_scene: 'Standby' }),
             defaultTransition: () => ({ name: 'Cut', duration_ms: 0 }) },
    follower: { paused: false, st: 'connected', snapshot() { return { status: this.st, error: null }; }, checkDrift: async () => { self.drift++; } },
    monitor: { reachable: true, snapshot() { return { reachable: this.reachable }; } },
    notes: new Notes(), client: obs, simulate: true, drift: 0,
    link: { status: null, since: 0, notified: null, fallback: false },
  };
  self._goFallback = Companion.prototype._goFallback.bind(self);
  self._checkVersion = () => {};
  self._masterPlayback = Companion.prototype._masterPlayback.bind(self);
  self._restartMedia = Companion.prototype._restartMedia.bind(self);
  self.watch = () => Companion.prototype._watchLink.call(self);
  self.age = ms => { self.link.since -= ms; };      // as if the state lasted ms longer
  return self;
}

test('master app quits: after 3 s, notification and fallback scene; back: follows again', async () => {
  const s = fakeSlave();
  await s.watch();                                   // all good
  s.monitor.reachable = false;                       // the master app quit
  await s.watch();
  assert.equal(s.client.current, 'Live Cam');        // not yet: a blip must not cut the show
  s.age(3100); await s.watch();
  assert.equal(s.client.current, 'Standby');
  assert.equal(s.follower.paused, true);
  assert.equal(s.notes.list.at(-1).title, 'Master connection lost');
  s.age(10000); await s.watch();
  assert.equal(s.notes.list.length, 1);              // told once
  s.monitor.reachable = true;
  await s.watch(); assert.equal(s.follower.paused, true);
  s.age(2100); await s.watch();
  assert.equal(s.follower.paused, false);
  assert.equal(s.notes.list.at(-1).title, 'Master back');
  assert.equal(s.drift, 1);                          // catches up the master's scene at once
});

test('master OBS lost, no fallback scene set: notification only', async () => {
  const s = fakeSlave();
  s.store.slaveConfig = () => ({ enabled: true, master_host: '10.0.0.5', master_name: 'REGIE', fallback_scene: '' });
  s.follower.st = 'connecting';
  await s.watch(); s.age(3100); await s.watch();
  assert.equal(s.client.current, 'Live Cam');
  assert.equal(s.notes.list.at(-1).title, 'Master connection lost');
});

test('"keep playing": the slave plays on the master playlist from where the master was', async () => {
  const s = fakeSlave();
  s.store.slaveConfig = () => ({ enabled: true, master_host: '10.0.0.5', master_name: 'REGIE', fallback_mode: 'continue' });
  s.store.playbackConfig = () => ({ restart_media_on_switch: false });
  s.client.current = 'Opening';
  s.wake = () => {};
  s.isPlaying = () => false; s.wasSlave = true;
  const playlist = { loop: false, default_transition: { name: 'Cut', duration_ms: 0 }, default_duration: 10,
    items: [{ id: 'a', scene: 'Opening', duration: 5 }, { id: 'b', scene: 'Interview', duration: 5 }] };
  s.monitor.data = { reachable: true, playlist: { playlist },
    state: { active_playlist: 'Show', fetched_at: Date.now() / 1000,
             player: { state: 'playing', item_id: 'a', scene: 'Opening', remaining: 0.3, loops: 0 } } };
  s.monitor.snapshot = function () { return { ...this.data, reachable: this.reachable }; };
  s._playOnAlone = Companion.prototype._playOnAlone.bind(s);
  await s.watch();
  s.monitor.reachable = false;
  await s.watch(); s.age(3100); await s.watch();
  assert.ok(s.backup, 'plays on alone');
  assert.equal(s.backup.snapshot(performance.now() / 1000).item_id, 'a');
  assert.equal(s.client.current, 'Opening');               // nothing sent: it is already on air
  await new Promise(r => setTimeout(r, 400));              // "a" ends
  s._execute = Companion.prototype._execute.bind(s);
  await Companion.prototype._step.call(s);
  assert.equal(s.client.current, 'Interview');
  // master back: this PC stops playing alone and follows it again
  s.monitor.reachable = true;
  await s.watch(); s.age(2100); await s.watch();
  assert.equal(s.backup, null);
  assert.equal(s.follower.paused, false);
});

test('a slave has no Playback settings of its own: the fallback scene comes in with the master\'s transition', async () => {
  const s = fakeSlave();
  s.monitor.snapshot = function () {
    return { reachable: this.reachable, state: this.reachable ? { playback: { default_transition: { name: 'Swipe', duration_ms: 800 },
             default_duration: 10, restart_media_on_switch: true } } : null };
  };
  await s.watch();                                   // master seen: its settings are kept
  s.monitor.reachable = false;
  await s.watch(); s.age(3100); await s.watch();
  assert.equal(s.client.current, 'Standby');
  assert.deepEqual(s.client.switchLog.at(-1), ['Standby', 'Swipe', 800]);
  // playing on alone: videos restart as the master's setting says
  s.backup = {}; s.backupPlayback = s._masterPlayback(null);
  assert.equal(s._restartMedia(s.backup), true);
});
