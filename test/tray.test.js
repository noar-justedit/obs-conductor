'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Notes } = require('../src/tray');

test('notifications are handed over once, recent ones only', () => {
  const n = new Notes();
  n.add('A', 'a'); n.add('B', 'b', 'warning');
  assert.deepEqual(n.since(0).map(x => x.title), ['A', 'B']);
  assert.deepEqual(n.since(1).map(x => x.title), ['B']);
  assert.equal(n.since(2).length, 0);
  n.list[0].at -= 120000;                               // two minutes old
  assert.deepEqual(n.since(0).map(x => x.title), ['B']);
});

test('tray dot: green, orange when versions differ, red when the master is lost', () => {
  const { Companion } = require('../src/main');
  const base = (over = {}) => Object.assign({
    store: { role: () => 'slave', locked: () => false, slaveConfig: () => ({ master_host: '10.0.0.5', master_name: 'REGIE' }) },
    local: { ws: 'ok' }, link: { fallback: false }, notes: new (require('../src/tray').Notes)(),
    follower: { snapshot: () => ({ status: 'connected' }) },
    sceneSync: { snapshot: () => ({ phase: 'idle' }) },
    updater: { snapshot: () => ({ local: '1.3.0', master: '1.3.0' }) },
    player: { snapshot: () => ({}) },
  }, over);
  const level = o => Companion.prototype.trayInfo.call(base(o), 0).level;
  assert.equal(level(), 'tray_ok');
  assert.equal(level({ updater: { snapshot: () => ({ local: '1.2.0', master: '1.3.0' }) } }), 'tray_warn');
  assert.equal(level({ link: { fallback: true } }), 'tray_error');
  assert.equal(level({ local: { ws: 'closed' } }), 'tray_error');
  assert.equal(level({ store: { role: () => '', locked: () => false, slaveConfig: () => ({}) } }), 'app');
});
