'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const D = require('../src/discovery');
const { startFakeObsWs } = require('./helpers/fake-obs-ws');

test('candidate addresses: the /24 of each card, this PC excluded', () => {
  const { hosts, networks } = D.candidateHosts({
    eth: [{ family: 'IPv4', address: '192.168.1.10', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    apipa: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
  });
  assert.equal(hosts.length, 253);
  assert.ok(!hosts.includes('192.168.1.10') && hosts.includes('192.168.1.1') && hosts.includes('192.168.1.254'));
  assert.deepEqual(networks, ['192.168.1.x']);
});

test('scan finds an OBS (Hello) and an OBS Conductor master on another OBS port', async () => {
  const obs = await startFakeObsWs({ password: 'pw' });
  const obsPort = obs.address().port;
  const app = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'obs-conductor', name: 'REGIE', role: 'master', version: '1.2.0', obs_port: obsPort }));
  });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  try {
    // OBS port given as 1 (closed): the master is found through its app, which tells its real OBS port
    const r = await D.scan({ hosts: ['127.0.0.1'], obsPort: 1, appPort: app.address().port, timeoutMs: 500 });
    assert.equal(r.found.length, 1);
    const f = r.found[0];
    assert.equal(f.name, 'REGIE');
    assert.equal(f.app.role, 'master');
    assert.deepEqual(f.obs, { port: obsPort, version: '5.5.2', auth: true });
    // plain OBS, no app
    const r2 = await D.scan({ hosts: ['127.0.0.1'], obsPort, appPort: 1, timeoutMs: 500 });
    assert.equal(r2.found[0].app, null);
    assert.equal(r2.found[0].obs.version, '5.5.2');
    // nothing there
    const r3 = await D.scan({ hosts: ['127.0.0.1'], obsPort: 1, appPort: 2, timeoutMs: 300 });
    assert.equal(r3.found.length, 0);
  } finally { obs.shutdown(); app.closeAllConnections(); app.close(); }
});

test('password test: right, wrong, nobody', async () => {
  const obs = await startFakeObsWs({ password: 'pw' });
  const port = obs.address().port;
  try {
    assert.deepEqual(await D.testObs('127.0.0.1', port, 'pw'), { ok: true });
    const bad = await D.testObs('127.0.0.1', port, 'nope');
    assert.equal(bad.ok, false); assert.equal(bad.wrong_password, true);
    const none = await D.testObs('127.0.0.1', 1, 'pw', 1500);
    assert.equal(none.ok, false); assert.ok(!none.wrong_password);
  } finally { obs.shutdown(); }
});

test('OBS started after the app: the app keeps trying and connects', async () => {
  const { ObsClient } = require('../src/obs');
  const net = require('net');
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const c = new ObsClient({ host: '127.0.0.1', port, password: 'pw' });
  const connected = new Promise(r => c.on('connected', r));
  c.start();                                            // nothing listens yet: refused
  await new Promise(r => setTimeout(r, 500));
  const obs = await startFakeObsWs({ password: 'pw', port });
  try {
    await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('never reconnected')), 8000))]);
  } finally { c.stop(); obs.shutdown(); }
});
