'use strict';
// Versions master / slave, and a slave's "Update" from its master (real HTTP
// server; the installer is a dummy file, never started).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsc-update-'));
const obsDir = path.join(tmp, 'obs');
process.env.OBS_CONFIG_DIR = obsDir;
process.env.OBSCONDUCTOR_DATA_DIR = path.join(tmp, 'data');
const { startServer } = require('../src/server');
const { Store } = require('../src/store');
const { FakeObs } = require('../src/fake-obs');
const { compare, InstallerInfo, Updater } = require('../src/update');

const quiet = { info() {}, warn() {}, error() {} };
const setup = path.join(tmp, 'OBSConductor-Setup.exe');
let server, port, app;

test.before(async () => {
  fs.mkdirSync(path.join(obsDir, 'plugin_config', 'obs-websocket'), { recursive: true });
  fs.writeFileSync(path.join(obsDir, 'plugin_config', 'obs-websocket', 'config.json'),
    JSON.stringify({ server_enabled: true, server_port: 4455, server_password: 'pw', auth_required: true }));
  fs.writeFileSync(setup, Buffer.alloc(2 << 20, 9));
  app = { store: new Store(path.join(tmp, 'pl'), path.join(tmp, 'settings.yaml')), client: new FakeObs(), simulate: false,
          log: quiet, ips: [], version: '1.3.0', installer: new InstallerInfo('1.3.0', setup, 'win32') };
  server = startServer(app, 0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});
test.after(() => server.close());

const slave = (version, password = 'pw', launch) =>
  new Updater(version, () => ({ host: '127.0.0.1', port, password }), quiet, { launch: launch || (async () => {}), platform: 'win32' });

test('version order', () => {
  assert.equal(compare('1.3.0', '1.2.9'), 1);
  assert.equal(compare('1.10.0', '1.9.0'), 1);
  assert.equal(compare('1.2.0', '1.2.0'), 0);
  assert.equal(compare('1.2', '1.2.1'), -1);
});

test('an older slave sees the update, downloads, checks and starts it', async () => {
  let started = null;
  const u = slave('1.2.0', 'pw', async f => { started = f; });
  await u.check(true);
  const s = u.snapshot();
  assert.equal(s.master, '1.3.0'); assert.equal(s.newer, true); assert.equal(s.available, true);
  await u.run();
  assert.equal(u.job.phase, 'installing');
  assert.ok(started);
  assert.deepEqual(fs.readFileSync(started), fs.readFileSync(setup));
});

test('same version or newer slave: no update', async () => {
  const same = slave('1.3.0'); await same.check(true);
  assert.equal(same.snapshot().newer, false); assert.equal(same.snapshot().available, false);
  const newer = slave('1.4.0'); await newer.check(true);
  assert.equal(newer.snapshot().older, true);
  await newer.run();
  assert.equal(newer.job.phase, 'error');
});

test('wrong password: refused, nothing started', async () => {
  let started = false;
  const u = slave('1.2.0', 'nope', async () => { started = true; });
  await u.run();
  assert.equal(u.job.phase, 'error'); assert.match(u.job.error, /password/);
  assert.equal(started, false);
});

test('a damaged download is not started', async () => {
  let started = false;
  const u = slave('1.2.0', 'pw', async () => { started = true; });
  await u.check(true);
  u.check = async () => u.remote;                       // keep the fingerprint read before the change
  u.remote.installer.sha256 = '0'.repeat(64);
  await u.run();
  assert.equal(u.job.phase, 'error'); assert.match(u.job.error, /damaged/);
  assert.equal(started, false);
});

test('a master without installer copy: version only, no Update', async () => {
  app.installer = new InstallerInfo('1.3.0', path.join(tmp, 'none.exe'));
  const u = slave('1.2.0'); await u.check(true);
  assert.equal(u.snapshot().newer, true); assert.equal(u.snapshot().available, false);
  app.installer = new InstallerInfo('1.3.0', setup, 'win32');
});

test('simulation: downloaded and checked, never started', async () => {
  let started = false;
  const u = new Updater('1.2.0', () => ({ host: '127.0.0.1', port, password: 'pw' }), quiet,
    { simulate: true, launch: async () => { started = true; }, platform: 'win32' });
  await u.run();
  assert.equal(u.job.phase, 'done'); assert.equal(u.job.simulated, true); assert.equal(started, false);
});

test('two clicks on Update: one download, one installer', async () => {
  let started = 0;
  const u = slave('1.2.0', 'pw', async () => { started++; });
  await u.check(true);
  await Promise.all([u.run(), u.run()]);
  assert.equal(started, 1);
});

test('macOS / Linux slave, or a master on another system: install by hand', async () => {
  const mac = new Updater('1.2.0', () => ({ host: '127.0.0.1', port, password: 'pw' }), quiet, { platform: 'darwin' });
  await mac.check(true);
  let s = mac.snapshot();
  assert.equal(s.newer, true); assert.equal(s.available, false); assert.equal(s.manual, true); assert.equal(s.other_os, true);
  app.installer = new InstallerInfo('1.3.0', setup, 'linux');
  const win = slave('1.2.0'); await win.check(true);
  s = win.snapshot();
  assert.equal(s.available, false); assert.equal(s.other_os, true); assert.equal(s.unsealed, false);
  await win.run();
  assert.equal(win.job.phase, 'error');
  app.installer = new InstallerInfo('1.3.0', setup, 'win32');
});
