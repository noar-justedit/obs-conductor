'use strict';
// Unit tests for src/player.js - run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/player');

function pl(items, { end = 'stop', endScene = '', def = ['Fade', 500] } = {}) {
  return P.normalize({
    default_transition: { name: def[0], duration_ms: def[1] },
    end_action: end === 'loop' ? 'stop' : end,
    loop: end === 'loop',
    end_scene: endScene,
    items: items.map(([scene, duration, transition, enabled], n) => ({ id: 'i' + n, scene, duration, transition, enabled })),
  });
}
const A = ['A', 10, null];
const B = ['B', 5, { name: 'Cut', duration_ms: 0 }];
const C = ['C', 2.5, null];

test('old list format is converted', () => {
  const out = P.normalize([
    { scene: 'X', time: '08:00:00', duration_seconds: null, enabled: true },
    { scene: 'Y', duration_seconds: 120, enabled: true },
    { scene: 'Z', duration_seconds: 30, enabled: false },
  ]);
  assert.deepEqual(out.items.map(i => i.scene), ['X', 'Y']);
  assert.equal(out.items[0].duration, null);            // follows the default
  assert.equal(P.durationOf(out, out.items[0]), P.DEFAULT_DURATION);
  assert.equal(out.items[1].duration, 120);
});

test('garbage is cleaned', () => {
  const out = P.normalize({ end_action: 'explode', items: [
    { scene: 'A', duration: 'abc' }, { duration: 3 }, { scene: 'B', duration: 0.1 },
  ] });
  assert.equal(out.end_action, 'stop');
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].duration, null);
  assert.equal(out.items[1].duration, P.MIN_DURATION);
  assert.ok(out.items.every(i => i.id));
});

test('duplicate ids are replaced', () => {
  const out = P.normalize({ items: [{ id: 'x', scene: 'A' }, { id: 'x', scene: 'B' }] });
  assert.notEqual(out.items[0].id, out.items[1].id);
});

test('total', () => assert.equal(P.totalDuration(pl([A, B, C])), 17.5));

test('sequence and transitions', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B, C]));
  p.play(0);
  let sw = p.tick(0);
  assert.equal(sw.scene, 'A'); assert.equal(sw.transition.name, 'Fade');
  assert.equal(p.tick(9.9), null);
  sw = p.tick(10);
  assert.equal(sw.scene, 'B'); assert.equal(sw.transition.name, 'Cut');
  assert.equal(p.tick(15).scene, 'C');
  assert.equal(p.tick(17.4), null);
});

test('end: stay on last', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, C]));
  p.play(0); p.tick(0); p.tick(10);
  assert.equal(p.tick(12.5), null);
  assert.equal(p.state, P.ENDED);
});

test('end: loop', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, C], { end: 'loop' }));
  p.play(0); p.tick(0); p.tick(10);
  assert.equal(p.tick(12.5).scene, 'A');
  assert.equal(p.loops, 1);
  assert.equal(p.snapshot(12.5).next_scene, 'C');
});

test('end: go to a scene', () => {
  const p = new P.Player(); p.setPlaylist(pl([A], { end: 'scene', endScene: 'Standby' }));
  p.play(0); p.tick(0);
  assert.equal(p.snapshot(1).next_scene, 'Standby');
  const sw = p.tick(10);
  assert.equal(sw.scene, 'Standby'); assert.equal(sw.transition.name, 'Fade');
  assert.equal(p.state, P.ENDED);
});

test('play from an index, next', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B, C]));
  p.play(0, 1);
  assert.equal(p.tick(0).scene, 'B');
  p.next(1);
  assert.equal(p.tick(1).scene, 'C');
  assert.equal(p.snapshot(1).remaining, 2.5);
});

test('stop', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B]));
  p.play(0); p.tick(0); p.stop();
  assert.equal(p.tick(100), null);
  assert.equal(p.snapshot(100).state, P.STOPPED);
});

test('reorder while playing keeps the item on air', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B, C]));
  p.play(0); p.tick(0);
  const n = pl([A, B, C]); n.items = [n.items[2], n.items[0], n.items[1]];
  p.setPlaylist(n);
  assert.equal(p.snapshot(1).index, 1);
  assert.equal(p.tick(10).scene, 'B');
});

test('duration edited while playing', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B]));
  p.play(0); p.tick(0);
  p.setPlaylist(pl([['A', 3, null], B]));
  assert.equal(p.tick(3).scene, 'B');
});

test('item on air deleted', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B, C]));
  p.play(0, 1); p.tick(0);
  const n = pl([A, B, C]); n.items.splice(1, 1);
  p.setPlaylist(n);
  const s = p.snapshot(1);
  assert.equal(s.scene, 'B'); assert.equal(s.index, -1); assert.equal(s.next_scene, 'C');
  assert.equal(p.tick(5).scene, 'C');
});

test('missing scene skipped', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B]));
  p.play(0); p.tick(0); p.skipMissing(0.1, 'A');
  assert.equal(p.tick(0.1).scene, 'B');
  assert.deepEqual(p.snapshot(0.1).skipped, ['A']);
});

test('only missing scenes: stops', () => {
  const p = new P.Player(); p.setPlaylist(pl([A], { end: 'loop' }));
  p.play(0); p.tick(0); p.skipMissing(0.1, 'A');
  assert.equal(p.state, P.STOPPED);
});

test('empty playlist does not start', () => {
  const p = new P.Player(); p.setPlaylist(pl([])); p.play(0);
  assert.equal(p.state, P.STOPPED);
});

test('playlist remaining', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B, C]));
  p.play(0); p.tick(0);
  assert.equal(p.snapshot(4).playlist_remaining, 13.5);
});

test('old "loop" end action becomes the loop switch', () => {
  const out = P.normalize({ end_action: 'loop', items: [{ scene: 'A' }] });
  assert.equal(out.loop, true); assert.equal(out.end_action, 'stop');
});

const OFF = ['B', 5, null, false];
test('disabled cue is skipped, and not counted', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, OFF, C]));
  assert.equal(P.totalDuration(p.playlist), 12.5);
  p.play(0); p.tick(0);
  assert.equal(p.snapshot(1).next_scene, 'C');
  assert.equal(p.snapshot(1).playlist_remaining, 11.5);
  assert.equal(p.tick(10).scene, 'C');
});

test('cue disabled live, while another plays', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, B, C]));
  p.play(0); p.tick(0);
  p.setPlaylist(pl([A, OFF, C]));
  assert.equal(p.tick(10).scene, 'C');
});

test('play from a disabled cue starts at the next enabled one', () => {
  const p = new P.Player(); p.setPlaylist(pl([A, OFF, C]));
  p.play(0, 1);
  assert.equal(p.tick(0).scene, 'C');
});

test('loop skips disabled cues at the top', () => {
  const p = new P.Player(); p.setPlaylist(pl([['A', 10, null, false], B, C], { end: 'loop' }));
  p.play(0); assert.equal(p.tick(0).scene, 'B');
  p.tick(5); assert.equal(p.tick(7.5).scene, 'B');
});

test('everything disabled: nothing plays', () => {
  const p = new P.Player(); p.setPlaylist(pl([['A', 10, null, false]], { end: 'loop' }));
  p.play(0); assert.equal(p.state, P.STOPPED);
});

test('cues without a duration follow the default duration, live', () => {
  const pl = P.normalize({ default_duration: 4, items: [{ scene: 'A' }, { scene: 'B', duration: 6 }] });
  assert.equal(P.totalDuration(pl), 10);
  const p = new P.Player(); p.setPlaylist(pl);
  p.play(0);
  assert.equal(p.tick(0).scene, 'A');
  assert.equal(p.tick(3.9), null);
  pl.default_duration = 2; p.setPlaylist(pl);          // the setting changes while A is on air
  assert.equal(p.tick(2.1).scene, 'B');
  assert.equal(p.snapshot(2.1).duration, 6);
});

test('cues follow each other on the clock, a late loop does not add up', () => {
  const P = require('../src/player');
  const pl = P.normalize({ items: Array.from({ length: 200 }, (_, i) => ({ scene: 'S' + i, duration: 10 })) });
  const p = new P.Player(); p.setPlaylist(pl);
  p.play(0); p.tick(0);
  let t = 0;
  for (let i = 1; i < 200; i++) { t = p.endsAt + 0.015; p.tick(t); }   // each tick 15 ms late
  assert.equal(p.startedAt, 1990);                                     // not 1990 + 199 x 0.015
});

test('a cue without its own duration follows a new default at once', () => {
  const P = require('../src/player');
  const p = new P.Player();
  p.setPlaylist(P.normalize({ items: [{ scene: 'A', duration: null }, { scene: 'B', duration: 5 }] }));
  p.setDefaults({ name: 'Fade', duration_ms: 500 }, 10);
  p.play(0); p.tick(0);
  assert.equal(p.endsAt, 10);
  p.setDefaults({ name: 'Fade', duration_ms: 500 }, 30);
  assert.equal(p.endsAt, 30);
});
