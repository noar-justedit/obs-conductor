'use strict';
// Security of the app's HTTP API (review 1.5.4): only this PC changes
// things; foreign pages and foreign host names are refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsc-sec-'));
process.env.OBS_CONFIG_DIR = path.join(tmp, 'obs');
process.env.OBSCONDUCTOR_DATA_DIR = path.join(tmp, 'data');
const { startServer } = require('../src/server');
const { Store } = require('../src/store');
const { FakeObs } = require('../src/fake-obs');

const quiet = { info() {}, warn() {}, error() {} };
let server, port;
const lanIp = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);

function call({ method = 'GET', p = '/api/state', host = '127.0.0.1', to = '127.0.0.1', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: to, port, method, path: p, headers: { Host: `${host}:${port}`, ...headers,
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (_) {} resolve({ code: res.statusCode, j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  const app = { store: new Store(path.join(tmp, 'pl'), path.join(tmp, 'settings.yaml')), client: new FakeObs(), simulate: true,
                log: quiet, ips: lanIp ? [lanIp.address] : [], version: 'x', state: () => ({ ok: true }) };
  server = startServer(app, 0, '0.0.0.0');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});
test.after(() => server.close());

const json = { 'Content-Type': 'application/json' };

test('a foreign host name is refused (DNS rebinding)', async () => {
  assert.equal((await call({ host: 'rebind.evil.example' })).code, 421);
  assert.equal((await call({ host: 'localhost' })).code, 200);
});

test('changes: a foreign page or a non-JSON body is refused', async () => {
  const lock = b => call({ method: 'POST', p: '/api/lock', headers: { ...json, ...b }, body: { locked: false } });
  assert.equal((await lock({ Origin: 'http://evil.example' })).code, 403);
  assert.equal((await lock({ Origin: 'null' })).code, 403);
  assert.equal((await lock({ Origin: `http://localhost:${port}` })).code, 200);
  assert.equal((await call({ method: 'POST', p: '/api/lock', headers: { 'Content-Type': 'text/plain' }, body: '{"locked":false}' })).code, 403);
});

test('the OBS password is given only to this PC, asked as localhost', async () => {
  assert.equal((await call({ p: '/api/master_info', host: 'localhost' })).j.password, 'sim-password');
  if (lanIp) assert.equal((await call({ p: '/api/master_info', host: lanIp.address })).j.password, null);
});

test('changes from another PC are refused', { skip: !lanIp }, async () => {
  const r = await call({ method: 'POST', p: '/api/lock', to: lanIp.address, host: lanIp.address, headers: json, body: { locked: true } });
  assert.equal(r.code, 403);
  assert.equal((await call({ p: '/api/state', to: lanIp.address, host: lanIp.address })).code, 200);   // reading stays open
});
