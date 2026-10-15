'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obscfg-'));
process.env.OBS_CONFIG_DIR = tmp;
// OBS may be open on the PC that builds: the tests must not depend on it
process.env.OBSCONDUCTOR_OBS_RUNNING = '0';
const S = require('../src/obs-setup');

const reset = () => { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); };
const read = f => fs.readFileSync(path.join(tmp, f), 'utf8');

test('iniSet keeps other lines, sections and CRLF', () => {
  const src = '[General]\r\nA=1\r\n\r\n[BasicWindow]\r\ngeometry=xyz\r\n\r\n[Other]\r\nB=2\r\n';
  const out = S.iniSet(src, 'BasicWindow', 'ExtraBrowserDocks', '[]');
  assert.strictEqual(out, '[General]\r\nA=1\r\n\r\n[BasicWindow]\r\ngeometry=xyz\r\nExtraBrowserDocks=[]\r\n\r\n[Other]\r\nB=2\r\n');
  const again = S.iniSet(out, 'BasicWindow', 'ExtraBrowserDocks', '[1]');
  assert.strictEqual(S.iniGet(again, 'BasicWindow', 'ExtraBrowserDocks'), '[1]');
  assert.strictEqual(again.split('ExtraBrowserDocks').length, 2);
  assert.strictEqual(S.iniSet('', 'X', 'k', 'v'), '[X]\nk=v\n');
});

test('dock goes into user.ini (OBS 31+), keeps the other docks, no duplicate', () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'global.ini'), '[General]\nX=1\n');
  fs.writeFileSync(path.join(tmp, 'user.ini'),
    '[BasicWindow]\nExtraBrowserDocks=[{"title":"Chat","url":"https://chat","uuid":"u1"}]\nDockState=abc\n');
  assert.strictEqual(S.addDock('http://localhost:8090/').added, true);
  let docks = JSON.parse(S.iniGet(read('user.ini'), 'BasicWindow', 'ExtraBrowserDocks'));
  assert.deepStrictEqual(docks.map(d => d.title), ['Chat', 'OBS Conductor']);
  assert.match(docks[1].uuid, /^[0-9a-f]{32}$/);
  assert.match(read('user.ini'), /DockState=abc/);
  assert.strictEqual(read('global.ini'), '[General]\nX=1\n');
  // reinstall with another port: updated, not duplicated
  assert.strictEqual(S.addDock('http://localhost:8091/').added, false);
  docks = JSON.parse(S.iniGet(read('user.ini'), 'BasicWindow', 'ExtraBrowserDocks'));
  assert.strictEqual(docks.length, 2);
  assert.strictEqual(docks[1].url, 'http://localhost:8091/');
  // uninstall: only ours goes
  assert.strictEqual(S.removeDock(), 1);
  docks = JSON.parse(S.iniGet(read('user.ini'), 'BasicWindow', 'ExtraBrowserDocks'));
  assert.deepStrictEqual(docks.map(d => d.title), ['Chat']);
});

test('older OBS: dock goes into global.ini; a dock added by hand on localhost is reused', () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'global.ini'),
    '[BasicWindow]\nExtraBrowserDocks=[{"title":"Playlist","url":"http://localhost:8090/","uuid":"u2"}]\n');
  assert.strictEqual(S.dockConfigFile(), path.join(tmp, 'global.ini'));
  assert.strictEqual(S.addDock('http://localhost:8090/').added, false);
  const docks = JSON.parse(S.iniGet(read('global.ini'), 'BasicWindow', 'ExtraBrowserDocks'));
  assert.deepStrictEqual(docks, [{ title: 'OBS Conductor', url: 'http://localhost:8090/', uuid: 'u2' }]);
});

test('websocket: existing config kept, server switched on', () => {
  reset();
  const dir = path.join(tmp, 'plugin_config', 'obs-websocket');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    alerts_enabled: false, auth_required: true, first_load: false, server_enabled: false,
    server_password: 'secret1', server_port: 4460 }));
  assert.deepStrictEqual(S.readWebsocket(), { port: 4460, password: 'secret1', enabled: false });
  assert.deepStrictEqual(S.enableWebsocket(), { port: 4460, password: 'secret1' });
  assert.strictEqual(S.readWebsocket().enabled, true);
});

test('websocket: no auth -> empty password; never configured -> created', () => {
  reset();
  const dir = path.join(tmp, 'plugin_config', 'obs-websocket');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auth_required: false, server_enabled: true, server_port: 4455, server_password: 'x' }));
  assert.strictEqual(S.readWebsocket().password, '');
  reset();
  assert.strictEqual(S.readWebsocket(), null);
  const ws = S.enableWebsocket();
  assert.strictEqual(ws.port, 4455);
  assert.ok(ws.password.length >= 12);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(c.server_enabled, true);
  assert.strictEqual(c.first_load, false);
});

test('websocket: OBS 28-29 settings in global.ini', () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'global.ini'),
    '[OBSWebSocket]\nFirstLoad=false\nServerEnabled=false\nServerPort=4455\nAuthRequired=true\nServerPassword=pw\n');
  assert.deepStrictEqual(S.enableWebsocket(), { port: 4455, password: 'pw', enabled: true });
  assert.match(read('global.ini'), /ServerEnabled=true/);
});

test('install refuses when OBS never ran for this user', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const log = console.log; console.log = () => {};
  try { assert.strictEqual(S.main('install'), 4); } finally { console.log = log; }
  fs.mkdirSync(tmp, { recursive: true });
});

test('install waits while OBS is open', () => {
  reset();
  const log = console.log; console.log = () => {};
  process.env.OBSCONDUCTOR_OBS_RUNNING = '1';
  try { assert.strictEqual(S.main('install'), 3); }
  finally { console.log = log; process.env.OBSCONDUCTOR_OBS_RUNNING = '0'; }
});

test('the dock of the app under its former name is renamed, not duplicated', () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'user.ini'),
    '[BasicWindow]\nExtraBrowserDocks=[{"title":"OBS Playlist","url":"http://localhost:8090/","uuid":"u9"}]\n');
  S.addDock('file:///C:/Program%20Files/OBS%20Conductor/app/src/dock-loader.html?port=8090');
  const docks = JSON.parse(S.iniGet(read('user.ini'), 'BasicWindow', 'ExtraBrowserDocks'));
  assert.equal(docks.length, 1);
  assert.equal(docks[0].title, 'OBS Conductor');
  assert.equal(docks[0].uuid, 'u9');
  assert.match(docks[0].url, /dock-loader\.html\?port=8090$/);
  assert.equal(S.removeDock(), 1);
});
