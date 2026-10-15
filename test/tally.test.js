'use strict';
// Tally from a PixelHue Q8: a fake switcher (REST part) answers like the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Q8Tally, stateOf, token, READ_ONLY, getJson } = require('../src/tally');

const quiet = { info() {}, warn() {}, error() {} };
// a layer as the switcher lists it: input shown, PGM (2) / PVW (4), screen
const layer = (name, sceneType, screen = 1) => ({ source: { general: { sourceName: name } }, layerIdObj: { sceneType, attachScreenId: screen } });
const screen = (screenId, type = 2, more = {}) => ({ screenId, screenIdObj: { type }, enable: 1, ftb: { enable: 0 }, ...more });

test('PGM layer = ON AIR, PVW layer = PVW, names compared exactly', () => {
  const layers = [layer('OBS HALL 8', 4), layer('CAM 1', 2), layer('OBS HALL 9', 0)];
  const screens = [screen(1)];
  assert.equal(stateOf(layers, screens, 'OBS HALL 8'), 'pvw');
  assert.equal(stateOf(layers, screens, 'CAM 1'), 'pgm');
  assert.equal(stateOf(layers, screens, 'OBS HALL 9'), 'none');
  assert.equal(stateOf(layers, screens, 'cam 1'), 'none');                // capitals count
  assert.equal(stateOf(layers, screens, ' CAM 1 '), 'pgm');               // spaces don't
  layers.push(layer('OBS HALL 8', 2));
  assert.equal(stateOf(layers, screens, 'OBS HALL 8'), 'pgm');             // PGM wins over PVW
});

test('the multiviewer, a disabled screen or a screen in FTB are not on air', () => {
  const screens = [screen(1), screen(9, 8), screen(2, 2, { enable: 0 }), screen(3, 2, { ftb: { enable: 1 } })];
  assert.equal(stateOf([layer('CAM 1', 2, 9)], screens, 'CAM 1'), 'none');   // multiviewer
  assert.equal(stateOf([layer('CAM 1', 2, 2)], screens, 'CAM 1'), 'none');   // disabled
  assert.equal(stateOf([layer('CAM 1', 2, 3)], screens, 'CAM 1'), 'none');   // faded to black
  assert.equal(stateOf([layer('CAM 1', 2, 1)], screens, 'CAM 1'), 'pgm');
  assert.equal(stateOf([layer('CAM 1', 2, 1)], [], 'CAM 1'), 'pgm');         // screens unknown: counts
});

test('talks to the switcher: token, polling, reconnect after a restart', async () => {
  let startTime = '1700000000', region = 2, calls = 0;
  const seen = [];                              // every request the app made
  const srv = http.createServer((req, res) => {
    seen.push([req.method, req.url.split('?')[0]]);
    const send = j => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url.startsWith('/unico/v1/node/open-detail')) return send({ code: 0, data: { sn: 'SN1', startTime } });
    if (req.headers.authorization !== token('SN1', startTime)) { res.writeHead(401); return res.end(); }
    calls++;
    if (req.url.startsWith('/unico/v1/screen/list-detail')) return send({ code: 0, data: { list: [screen(1)] } });
    if (req.url.startsWith('/unico/v1/layers/list-detail')) return send({ code: 0, data: { list: [layer('OBS HALL 8', region)] } });
    if (req.url.startsWith('/unico/v1/interface/list-detail')) return send({ code: 0, data: { list: [
      { general: { name: 'CAM 1' } }, { general: { name: 'OBS HALL 10' } }, { general: { name: 'OBS HALL 8' } }] } });
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const t = new Q8Tally(() => ({ host: '127.0.0.1', input: 'OBS HALL 8', api_port: srv.address().port }), quiet);
  const until = async f => { for (let i = 0; i < 60 && !f(); i++) await new Promise(r => setTimeout(r, 100)); };
  try {
    await until(() => t.snapshot().state === 'pgm');
    assert.equal(t.snapshot().state, 'pgm');
    region = 4;
    await until(() => t.snapshot().state === 'pvw');
    assert.equal(t.snapshot().state, 'pvw');
    startTime = '1800000000';                 // the switcher restarted: old token refused
    region = 2;
    await until(() => t.snapshot().state === 'pgm');
    assert.equal(t.snapshot().state, 'pgm');
    assert.ok(calls > 3);
    // the inputs, read from the switcher (nothing to type)
    assert.deepEqual(await t.inputs(), ['CAM 1', 'OBS HALL 8', 'OBS HALL 10']);
    // Settings > Test connection: connects again, reads the inputs and screens
    const r = await t.test();
    assert.equal(r.ok, true); assert.equal(r.sn, 'SN1'); assert.equal(r.inputs, 3); assert.equal(r.screens, 1);
    // READ ONLY (absolute rule): only GETs, only to read addresses
    assert.ok(seen.length > 5);
    for (const [method, path] of seen) {
      assert.equal(method, 'GET', `${method} ${path}`);
      assert.ok(READ_ONLY.includes(path), path);
    }
  } finally { t.stop(); srv.close(); }
});

test('Test connection: no address, switcher away', async () => {
  const none = new Q8Tally(() => ({ host: '', input: '' }), quiet);
  const away = new Q8Tally(() => ({ host: '127.0.0.1', input: 'X', api_port: 9 }), quiet);
  try {
    assert.equal((await none.test()).ok, false);
    const r = await away.test();
    assert.equal(r.ok, false); assert.ok(r.error);
  } finally { none.stop(); away.stop(); }
});

test('READ ONLY: any other address is refused before anything is sent', async () => {
  let hit = 0;
  const srv = http.createServer((req, res) => { hit++; res.end('{}'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of ['/unico/v1/preset/take', '/unico/v1/preset/apply', '/unico/v1/layers', '/unico/v1/screen/ftb', '/unico/v1/preset', '/']) {
      await assert.rejects(getJson(base + p), /read only/);
    }
    assert.equal(hit, 0);
  } finally { srv.close(); }
});

test('the input named like this PC is suggested, only when there is no doubt', () => {
  const { suggestInput } = require('../src/tally');
  const inputs = ['CAM 1', 'OBS HALL 8', 'OBS HALL 9', 'PLAYBACK'];
  assert.equal(suggestInput(inputs, 'HALL8'), 'OBS HALL 8');
  assert.equal(suggestInput(inputs, 'hall-9'), 'OBS HALL 9');
  assert.equal(suggestInput(inputs, 'DESKTOP-AB12CD'), null);
  assert.equal(suggestInput(['OBS HALL 8', 'HALL 8 BACKUP'], 'HALL8'), null);   // two match: no guess
});

test('real Q8 answer: the OBS feed is on air, its look-alike only on the multiviewer', () => {
  const { tallyOf } = require('../src/tally');
  const q = require('./fixtures/q8-hall8.json');
  const obs = tallyOf(q.layers, q.screens, 'OBS HALL 8');
  assert.equal(obs.state, 'pgm');
  assert.deepEqual(obs.pgm, ['HALL 8']);
  const look = tallyOf(q.layers, q.screens, 'HALL 8');
  assert.equal(look.state, 'none');
  assert.equal(look.multiviewer, true);
  assert.equal(tallyOf(q.layers, q.screens, 'IPTV7 NO CURRENT').pgm.includes('Monitor'), false);   // layer switched off
});
