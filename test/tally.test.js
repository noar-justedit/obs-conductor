'use strict';
// Tally engine + PixelHue driver: a fake switcher (REST part) answers like the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { TallyEngine, stateOf, token, READ_ONLY, getJson, suggestInput, tallyOf, catalog } = require('../src/tally/index');
const guard = require('../src/tally/guard');
// the tally starts CUT (STOP TALLY on): these tests run with it on
test.before(() => guard.setCut(false));

const quiet = { info() {}, warn() {}, error() {} };
// a layer as the switcher lists it: input shown, PGM (2) / PVW (4), screen
const layer = (name, sceneType, screen = 1) => ({ source: { general: { sourceName: name } }, layerIdObj: { sceneType, attachScreenId: screen } });
const screen = (screenId, type = 2, more = {}) => ({ screenId, screenIdObj: { type }, enable: 1, ftb: { enable: 0 }, ...more });
const until = async f => { for (let i = 0; i < 80 && !f(); i++) await new Promise(r => setTimeout(r, 100)); };

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

test('engine + PixelHue: token, polling, reconnect after a restart, inputs, test', async () => {
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
  // a 2.1 config: no model (= PixelHue), the input by its name
  const cfg = { device: 'pixelhue', host: '127.0.0.1', input: 'OBS HALL 8', api_port: srv.address().port };
  const t = new TallyEngine(() => cfg, quiet);
  try {
    await until(() => t.snapshot().state === 'pgm');
    assert.equal(t.snapshot().state, 'pgm');
    assert.equal(t.snapshot().input, 'OBS HALL 8');
    region = 4;
    await until(() => t.snapshot().state === 'pvw');
    assert.equal(t.snapshot().state, 'pvw');
    startTime = '1800000000';                 // the switcher restarted: old token refused
    region = 2;
    await until(() => t.snapshot().state === 'pgm');
    assert.equal(t.snapshot().state, 'pgm');
    assert.ok(calls > 3);
    // the inputs, read from the switcher (nothing to type)
    const r = await t.inputs();
    assert.deepEqual(r.inputs.map(i => i.name), ['CAM 1', 'OBS HALL 8', 'OBS HALL 10']);
    assert.deepEqual(r.states['OBS HALL 8'].pgm, ['Screen 1']);
    // Settings > Test connection: connects again, reads everything once
    const tr = await t.test();
    assert.equal(tr.ok, true); assert.equal(tr.inputs, 3); assert.equal(tr.screens, 1);
    // READ ONLY (absolute rule): only GETs, only to read addresses
    assert.ok(seen.length > 5);
    for (const [method, path] of seen) {
      assert.equal(method, 'GET', `${method} ${path}`);
      assert.ok(READ_ONLY.includes(path), path);
    }
  } finally { t.stop(); srv.close(); }
});

test('Test connection: no model, no address, switcher away', async () => {
  const none = new TallyEngine(() => ({ device: '', host: '', input: '' }), quiet);
  const noHost = new TallyEngine(() => ({ device: 'vmix', host: '', input: '' }), quiet);
  const away = new TallyEngine(() => ({ device: 'pixelhue', host: '127.0.0.1', input: 'X', api_port: 9 }), quiet);
  try {
    assert.match((await none.test()).error, /model/);
    assert.match((await noHost.test()).error, /address/);
    const r = await away.test();
    assert.equal(r.ok, false); assert.ok(r.error);
    await until(() => away.snapshot().error);
    assert.equal(away.snapshot().connected, false);
    assert.match(away.snapshot().error, /PixelHue/);
  } finally { none.stop(); noHost.stop(); away.stop(); }
});

test('READ ONLY: any other PixelHue address is refused before anything is sent', async () => {
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
  const inputs = ['CAM 1', 'OBS HALL 8', 'OBS HALL 9', 'PLAYBACK'];
  assert.equal(suggestInput(inputs, 'HALL8'), 'OBS HALL 8');
  assert.equal(suggestInput(inputs, 'hall-9'), 'OBS HALL 9');
  assert.equal(suggestInput(inputs, 'DESKTOP-AB12CD'), null);
  assert.equal(suggestInput(['OBS HALL 8', 'HALL 8 BACKUP'], 'HALL8'), null);   // two match: no guess
  // [{id, name}] (every machine but PixelHue): the id comes back
  assert.equal(suggestInput([{ id: '3', name: 'CAM 1' }, { id: '7', name: 'OBS HALL8' }], 'HALL8'), '7');
});

test('real Q8 answer: the OBS feed is on air, its look-alike only on the multiviewer', () => {
  const q = require('./fixtures/q8-hall8.json');
  const obs = tallyOf(q.layers, q.screens, 'OBS HALL 8');
  assert.equal(obs.state, 'pgm');
  assert.deepEqual(obs.pgm, ['HALL 8']);
  const look = tallyOf(q.layers, q.screens, 'HALL 8');
  assert.equal(look.state, 'none');
  assert.equal(look.multiviewer, true);
  assert.equal(tallyOf(q.layers, q.screens, 'IPTV7 NO CURRENT').pgm.includes('Monitor'), false);   // layer switched off
});

test('the machine list: the ten families asked for, without V-60HD', () => {
  const ids = catalog().map(d => d.id);
  for (const id of ['atem', 'roland', 'vmix', 'tricaster', 'eventmaster', 'livepremier', 'livecore', 'pixelhue', 'kairos']) assert.ok(ids.includes(id), id);
  assert.ok(!catalog().some(d => /V-60HD/.test(d.label)));
});
