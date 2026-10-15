'use strict';
// Every tally machine against a fake one that answers like the real one (from
// the protocol documents). Each fake writes down everything it receives: all
// of it must be in the driver's closed list of reads (ABSOLUTE RULE).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const guard = require('../src/tally/guard');
const { BY_ID, TallyEngine } = require('../src/tally/index');

// the tally starts CUT (STOP TALLY on): these tests run with it on
test.before(() => guard.setCut(false));

const quiet = { info() {}, warn() {}, error() {} };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const until = async f => { for (let i = 0; i < 80 && !(await f()); i++) await new Promise(r => setTimeout(r, 50)); };

/** Every message the fake got must be one the driver's rules allow. */
function assertAllRead(driverId, received, rules = BY_ID[driverId].RULES) {
  assert.ok(received.length > 0, `${driverId}: nothing received`);
  for (const m of received) assert.ok(guard.allowed(rules, m), `${driverId} sent a non-read: ${JSON.stringify(m)}`);
}
/** TCP data split into messages, line endings kept. */
const lines = s => (String(s).match(/[^\n]*\n|[^\n]+$/g) || []);

// ---- every driver's list refuses its forbidden examples ------------------------

test('READ ONLY: each driver refuses its forbidden messages (commands)', () => {
  for (const d of Object.values(BY_ID)) {
    assert.ok(d.RULES && d.RULES.length, d.id);
    assert.ok(d.FORBIDDEN && d.FORBIDDEN.length, `${d.id}: give examples of refused messages`);
    for (const f of d.FORBIDDEN) assert.equal(guard.allowed(d.RULES, f), false, `${d.id} would allow ${f}`);
  }
  // the lists the guard uses are the drivers' own, frozen
  for (const d of Object.values(BY_ID)) { assert.equal(guard.rulesOf(d.id), d.RULES); assert.ok(Object.isFrozen(d.RULES)); }
  assert.throws(() => guard.register('vmix', []), /twice/);
});

test('READ ONLY: no driver opens a network connection itself (all through guard.js)', () => {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'tally', 'drivers');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/require\(\s*['"](node:)?(net|dgram|http|https|tls|http2)['"]\s*\)/.test(src), `${f} loads a network module`);
  }
});

test('READ ONLY: the guard refuses before anything leaves the PC (HTTP, TCP, UDP)', async () => {
  let hits = 0;
  const srv = http.createServer((q, s) => { hits++; s.end(); });
  const port = await listen(srv);
  guard.register('test-http', [guard.rule('GET /read', /^GET \/read$/)]);
  guard.register('test-tcp', [guard.rule('XML', /^XML\r\n$/)]);
  const req = guard.httpClient('test-http');
  await assert.rejects(req(`http://127.0.0.1:${port}/take`), /read only/);
  await assert.rejects(req(`http://127.0.0.1:${port}/read`, { method: 'POST', body: '{}' }), /read only/);
  await assert.rejects(req(`http://127.0.0.1:${port}/read?Function=Cut`), /read only/);
  assert.equal(hits, 0);
  srv.close();
  let got = '';
  const tcp = net.createServer(c => c.on('data', d => { got += d; }));
  const tport = await listen(tcp);
  const s = new guard.GuardedSocket('test-tcp', { host: '127.0.0.1', port: tport });
  await s.connect();
  assert.throws(() => s.send('FUNCTION Cut\r\n'), /read only/);
  assert.throws(() => s.send('XML\r\nFUNCTION Cut\r\n'), /read only/);
  s.send('XML\r\n');
  await until(() => got.length);
  assert.equal(got, 'XML\r\n');
  s.close(); tcp.close();
  const a = BY_ID.atem;
  assert.equal(a.isAllowedPacket(a.hello()), true);
  assert.equal(a.isAllowedPacket(a.ackPacket(0x8123, 77)), true);
  const u = new guard.GuardedUdp('atem');
  u.sock.send = () => { throw new Error('sent!'); };
  for (const f of a.FORBIDDEN) assert.throws(() => u.send(f, 9910, '127.0.0.1'), /read only/);
  assert.throws(() => u.send('hello', 9910, '127.0.0.1'), /read only/);
  u.close();
});

// ---- Blackmagic ATEM (UDP) ------------------------------------------------------

function atemPacket(flags, session, id, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(12 + payload.length);
  b.writeUInt16BE((flags << 11) | b.length, 0); b.writeUInt16BE(session, 2); b.writeUInt16BE(id, 10);
  payload.copy(b, 12);
  return b;
}
function atemCmd(name, body) { const h = Buffer.alloc(8); h.writeUInt16BE(8 + body.length, 0); h.write(name, 4, 'ascii'); return Buffer.concat([h, body]); }
function inPr(id, long, short, type = 0) {
  const b = Buffer.alloc(36); b.writeUInt16BE(id, 0); b.write(long, 2, 'utf8'); b.write(short, 22, 'ascii'); b[32] = type; return atemCmd('InPr', b);
}
function tlSr(map) {
  const e = Object.entries(map), b = Buffer.alloc(2 + e.length * 3); b.writeUInt16BE(e.length, 0);
  e.forEach(([src, v], i) => { b.writeUInt16BE(+src, 2 + i * 3); b[4 + i * 3] = v; });
  return atemCmd('TlSr', b);
}

test('ATEM: hello, acks only; inputs from InPr, tally from TlSr', async () => {
  const sock = dgram.createSocket('udp4'), received = [];
  let client = null, id = 0;
  const S = 0x8001;
  const send = p => sock.send(p, client.port, client.address);
  sock.on('message', (m, r) => {
    received.push(m); client = r;
    if (m.equals(BY_ID.atem.hello())) {
      const p = atemPacket(0x02, S, 0, Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0])); send(p);
    } else if (m.length === 12 && m.readUInt16BE(4) === 0 && id === 0) {
      const pin = Buffer.alloc(44); pin.write('ATEM Mini Pro', 0);
      send(atemPacket(0x01, S, ++id, Buffer.concat([atemCmd('_pin', pin), inPr(1, 'Camera 1', 'CAM1'), inPr(2, 'OBS HALL 8', 'OBS'),
        inPr(1000, 'Color Bars', 'BARS', 2), tlSr({ 1: 1, 2: 2, 1000: 0 })])));
      send(atemPacket(0x01, S, ++id, atemCmd('InCm', Buffer.alloc(0))));
    }
  });
  await new Promise(r => sock.bind(0, '127.0.0.1', r));
  const port = sock.address().port;
  const s = BY_ID.atem.create({ host: '127.0.0.1', port }, quiet);
  try {
    const r = await s.read();
    assert.equal(r.model, 'ATEM Mini Pro');
    assert.deepEqual(r.inputs, [{ id: '1', name: 'Camera 1' }, { id: '2', name: 'OBS HALL 8' }]);   // bars: not an input
    assert.deepEqual(r.tally['1'], { pgm: ['PGM'], pvw: [] });
    assert.deepEqual(r.tally['2'], { pgm: [], pvw: ['PVW'] });
    // the switcher changes: a new TlSr, OBS on air
    send(atemPacket(0x01, S, ++id, tlSr({ 1: 2, 2: 1 })));
    await until(async () => (await s.read()).tally['2'].pgm.length);
    assert.deepEqual((await s.read()).tally['2'].pgm, ['PGM']);
    // a packet after a gap is not acknowledged (it will come again)
    send(atemPacket(0x01, S, id + 5, tlSr({ 2: 0 })));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual((await s.read()).tally['2'].pgm, ['PGM']);
    for (const m of received) assert.ok(BY_ID.atem.isAllowedPacket(m), m.toString('hex'));
    assert.ok(received.length >= 3);
  } finally { s.close(); sock.close(); }
});

// ---- vMix (TCP 8099) ---------------------------------------------------------------

test('vMix: only "XML"; PGM / PVW / overlays by input key', async () => {
  const received = [];
  let active = 2;
  const xml = () => `<vmix><version>27.0.0.49</version><edition>4K</edition><inputs>
    <input key="k-cam" number="1" type="Capture" title="Cam 1" shortTitle="Cam 1">Cam 1</input>
    <input key="k-obs" number="2" type="NDI" title="OBS HALL 8 &amp; co">OBS<overlay index="0" key="k-cam"/></input>
    <input key="k-gfx" number="3" type="GT" title="Lower third"/></inputs>
    <overlays><overlay number="1">3</overlay><overlay number="2" preview="True">1</overlay><overlay number="3"/></overlays>
    <preview>1</preview><active>${active}</active><mix number="2"><preview>3</preview><active>3</active></mix></vmix>`;
  const srv = net.createServer(c => {
    c.write('VERSION OK 27.0.0.49\r\n');
    let buf = '';
    c.on('data', d => { buf += d; for (const l of lines(buf)) received.push(l); buf = ''; const x = Buffer.from(xml()); c.write(`XML ${x.length}\r\n`); c.write(x); });
  });
  const port = await listen(srv);
  const s = BY_ID.vmix.create({ host: '127.0.0.1', port }, quiet);
  try {
    let r = await s.read();
    assert.equal(r.model, 'vMix 4K 27.0.0.49');
    assert.deepEqual(r.inputs.map(i => [i.id, i.name]), [['k-cam', 'Cam 1'], ['k-obs', 'OBS HALL 8 & co'], ['k-gfx', 'Lower third']]);
    assert.deepEqual(r.tally['k-obs'], { pgm: ['PGM'], pvw: [] });
    // Cam 1 is also a layer of the OBS input on program: on air too
    assert.deepEqual(r.tally['k-cam'], { pgm: ['PGM (layer)'], pvw: ['PVW', 'Overlay 2'] });
    assert.deepEqual(r.tally['k-gfx'], { pgm: ['Overlay 1'], pvw: [] });    // overlay on air; Mix 2 doesn't count
    active = 1;
    r = await s.read();
    assert.deepEqual(r.tally['k-obs'].pgm, []);
    assertAllRead('vmix', received);
  } finally { s.close(); srv.close(); }
});

// ---- TriCaster (HTTP, Digest login) ----------------------------------------------------

test('TriCaster: three GETs only, Digest login, names from shortcut_states', async () => {
  const received = [];
  const md5 = x => crypto.createHash('md5').update(x).digest('hex');
  const srv = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    const a = req.headers.authorization || '';
    const p = {}; a.replace(/(\w+)="?([^",]*)"?/g, (_, k, v) => { p[k] = v; return ''; });
    const ok = /^Digest/.test(a) && p.response === md5(`${md5('admin:tc:secret')}:n1:${p.nc}:${p.cnonce}:auth:${md5(`GET:${p.uri}`)}`);
    if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="tc", nonce="n1", qop="auth"' }); return res.end(); }
    if (req.url === '/v1/version') return res.end('<product_information><product_name>TriCaster 2 Elite</product_name><product_version>8-1</product_version></product_information>');
    if (req.url === '/v1/dictionary?key=tally') return res.end('<tally><column index="0" name="input1" on_pgm="false" on_prev="true"/><column index="1" name="INPUT2" on_pgm="true" on_prev="false"/><column index="5" name="ddr1_a" on_pgm="true" on_prev="false"/></tally>');
    if (req.url === '/v1/dictionary?key=shortcut_states') return res.end('<shortcut_states><shortcut_state name="input2_long_name" value="OBS HALL 8" type="" sender=""/></shortcut_states>');
    res.writeHead(404); res.end();
  });
  const port = await listen(srv);
  const s = BY_ID.tricaster.create({ host: '127.0.0.1', port, user: 'admin', password: 'secret' }, quiet);
  try {
    const r = await s.read();
    assert.equal(r.model, 'TriCaster 2 Elite 8-1');
    assert.deepEqual(r.inputs.map(i => i.id), ['input1', 'input2']);          // DDR sub-source hidden
    assert.equal(r.inputs[1].name, 'OBS HALL 8 (input2)');
    assert.deepEqual(r.tally.input2, { pgm: ['PGM'], pvw: [] });
    assert.deepEqual(r.tally.input1, { pgm: [], pvw: ['PVW'] });
    assertAllRead('tricaster', received);
  } finally { s.close(); srv.close(); }
});

// ---- Barco Event Master / Encore 3 (JSON-RPC) -----------------------------------------------

test('Barco E2: five read methods only; layers, background and aux mapped to inputs', async () => {
  const received = [];
  let pgmSrc = 11;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      received.push(`${req.method} ${req.url} ${body}`);
      const j = JSON.parse(body), p = j.params || {};
      const R = response => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { success: 0, response } }));
      switch (j.method) {
        case 'getFrameSettings': return R({ System: { FrameCollection: { Frame: { FrameType: 0, FrameTypeName: 'E2', Version: '7.2' } } } });
        case 'listSources': return R(p.type === 1 ? [{ id: 0, Name: 'BG cam', InputCfgIndex: 0 }]
          : [{ id: 10, Name: 'CAM 1', InputCfgIndex: 0, SrcType: 0 }, { id: 11, Name: 'OBS HALL 8', InputCfgIndex: 3, SrcType: 0 }, { id: 12, Name: 'Still', InputCfgIndex: -1, SrcType: 1 }]);
        case 'listDestinations': return R({ ScreenDestination: [{ id: 0, Name: 'LED' }], AuxDestination: [{ id: 0, Name: 'Record' }] });
        case 'listContent': return R({ id: 0, Layers: [{ id: 0, LastSrcIdx: pgmSrc, PgmMode: 1, PvwMode: 0 }, { id: 1, LastSrcIdx: 10, PgmMode: 0, PvwMode: 1 }],
          BGLyr: [{ id: 0, LastBGSourceIndex: 0, BGShowMatte: 0 }, { id: 1, LastBGSourceIndex: -1, BGShowMatte: 0 }] });
        case 'listAuxContent': return R({ id: 0, PgmLastSrcIndex: 11, PvwLastSrcIndex: -1 });
        default: res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { message: 'unknown' } }));
      }
    });
  });
  const port = await listen(srv);
  const s = BY_ID.eventmaster.create({ host: '127.0.0.1', port }, quiet);
  try {
    let r = await s.read();
    assert.equal(r.model, 'Barco E2 7.2');
    assert.deepEqual(r.inputs, [{ id: '0', name: 'CAM 1' }, { id: '3', name: 'OBS HALL 8' }]);
    assert.deepEqual(r.tally['3'], { pgm: ['LED', 'Record'], pvw: [] });
    assert.deepEqual(r.tally['0'], { pgm: ['LED (background)'], pvw: ['LED'] });
    pgmSrc = 10;
    r = await s.read();
    assert.deepEqual(r.tally['3'].pgm, ['Record']);
    assertAllRead('eventmaster', received);
    for (const m of received) assert.ok(/"method":"(getFrameSettings|listSources|listDestinations|listContent|listAuxContent)"/.test(m), m);
  } finally { s.close(); srv.close(); }
});

// ---- Analog Way Aquilon (REST) ---------------------------------------------------------------

test('Aquilon: GETs only; layer program / preview presets -> inputs', async () => {
  const received = [];
  const routes = {
    '/api/tpp/v1/system': { type: 'AQL RS2', version: { major: 4 } },
    '/api/tpp/v1/screens/1': { isEnabled: true, label: 'Main LED' },
    '/api/tpp/v1/screens/1/layers/1': { capacity: 2 }, '/api/tpp/v1/screens/1/layers/2': { capacity: 1 }, '/api/tpp/v1/screens/1/layers/3': { capacity: 0 },
    '/api/tpp/v1/screens/1/layers/1/presets/program': { status: 'open', sourceType: 'input', sourceId: 8 },
    '/api/tpp/v1/screens/1/layers/1/presets/preview': { status: 'open', sourceType: 'input', sourceId: 2 },
    '/api/tpp/v1/screens/1/layers/2/presets/program': { status: 'close', sourceType: 'input', sourceId: 2 },
    '/api/tpp/v1/screens/1/layers/2/presets/preview': { status: 'open', sourceType: 'color', sourceId: 1 },
    '/api/tpp/v1/inputs/1': { isEnabled: true, label: 'CAM 1' }, '/api/tpp/v1/inputs/2': { isEnabled: true, label: 'CAM 2' },
    '/api/tpp/v1/inputs/3': { isEnabled: false },
  };
  for (let i = 4; i <= 8; i++) routes[`/api/tpp/v1/inputs/${i}`] = { isEnabled: true, label: i === 8 ? 'OBS HALL 8' : '' };
  const srv = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    const r = routes[req.url];
    if (!r) { res.writeHead(404); return res.end(); }
    res.end(JSON.stringify(r));
  });
  const port = await listen(srv);
  const s = BY_ID.livepremier.create({ host: '127.0.0.1', port }, quiet);
  try {
    const r = await s.read();
    assert.equal(r.model, 'Analog Way AQL RS2');
    assert.ok(r.inputs.some(i => i.id === '8' && i.name === 'OBS HALL 8 (IN 8)'));
    assert.ok(!r.inputs.some(i => i.id === '3'));                              // disabled input
    assert.deepEqual(r.tally['8'], { pgm: ['Main LED'], pvw: [] });
    assert.deepEqual(r.tally['2'], { pgm: [], pvw: ['Main LED'] });            // its PGM layer is closed
    assertAllRead('livepremier', received);
    assert.ok(received.every(m => m.startsWith('GET ')));
  } finally { s.close(); srv.close(); }
});

// ---- Analog Way Ascender (LiveCore TCP) ----------------------------------------------------

test('Ascender (LiveCore): "?" and "<i>,TAopr / TAopw" reads only', async () => {
  const received = [];
  const pgm = { 3: 1 }, pvw = { 5: 1 };
  const srv = net.createServer(c => {
    c.write('TPcon0,1\r\n');
    let buf = '';
    c.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i + 1); buf = buf.slice(i + 1); received.push(l);
        let m;
        if (l === '?\n') c.write('DEV100\r\n');
        else if ((m = /^(\d+),TAop([rw])\n$/.exec(l))) { const n = +m[1]; if (n <= 8) c.write(`TAop${m[2]}${n},${(m[2] === 'r' ? pgm : pvw)[n] || 0}\r\n`); else c.write('E10\r\n'); }
      }
    });
  });
  const port = await listen(srv);
  const s = BY_ID.livecore.create({ host: '127.0.0.1', port }, quiet);
  try {
    let r = await s.read();
    await until(async () => (r = await s.read()).inputs.length === 8);
    assert.equal(r.model, 'Analog Way Ascender 48');
    assert.equal(r.inputs.length, 8);
    assert.deepEqual(r.tally['3'], { pgm: ['PGM'], pvw: [] });
    assert.deepEqual(r.tally['5'], { pgm: [], pvw: ['PVW'] });
    assertAllRead('livecore', received);
  } finally { s.close(); srv.close(); }
});

// ---- Roland V-160HD (TCP 8023) -------------------------------------------------------------

test('Roland V-160HD: password, VER;, RQH tally read only (never DTH)', async () => {
  const received = [];
  const bytes = Array(16).fill(0); bytes[8] = 1; bytes[0] = 2; bytes[1] = 3;   // SDI 1 PGM, HDMI 1 PST, HDMI 2 both
  const srv = net.createServer(c => {
    c.write('Enter password:');
    let auth = false, buf = '';
    c.on('data', d => {
      buf += d;
      for (const l of lines(buf)) {
        if (!l.endsWith('\n')) { buf = l; continue; }
        received.push(l);
        if (!auth) { if (l === '4321\n') { auth = true; c.write('Welcome to V-160HD.\r\n'); } else c.end(); }
        else if (l === 'VER;\n') c.write('\x02VER:V-160HD,2.00;');
        else if (l === 'RQH:0C0000,000010;\n') c.write('\x02DTH:0C0000,' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() + ';');
      }
      if (lines(buf).every(l => l.endsWith('\n'))) buf = '';
    });
  });
  const port = await listen(srv);
  const s = BY_ID.roland.create({ host: '127.0.0.1', port, password: '4321' }, quiet);
  try {
    const r = await s.read();
    assert.match(r.model, /V-160HD/);
    assert.equal(r.inputs[8].name, 'SDI 1');
    assert.deepEqual(r.tally['8'], { pgm: ['PGM'], pvw: [] });
    assert.deepEqual(r.tally['0'], { pgm: [], pvw: ['PST'] });
    assert.deepEqual(r.tally['1'], { pgm: ['PGM'], pvw: ['PST'] });
    assertAllRead('roland', received);
    assert.ok(!received.some(l => l.startsWith('DTH')));
    assert.ok(received.includes('4321\n'));
    await assert.rejects(BY_ID.roland.create({ host: '127.0.0.1', port, password: '' }, quiet).read(), /password/);
  } finally { s.close(); srv.close(); }
});

// ---- Panasonic KAIROS (REST) ---------------------------------------------------------------

test('KAIROS: GET /inputs only, Basic login; tally bit 0 on air, bit 1 preview', async () => {
  const received = [];
  const srv = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== 'Basic ' + Buffer.from('Kairos:pw').toString('base64')) { res.writeHead(401); return res.end(); }
    res.end(JSON.stringify([{ uuid: 'u1', index: 1, name: 'CAM 1', tally: 2 }, { uuid: 'u2', index: 2, name: 'OBS HALL 8', tally: 1 }, { uuid: 'u3', index: 3, name: 'IN3', tally: 0 }]));
  });
  const port = await listen(srv);
  const s = BY_ID.kairos.create({ host: '127.0.0.1', port, password: 'pw' }, quiet);
  try {
    const r = await s.read();
    assert.deepEqual(r.inputs.map(i => i.name), ['CAM 1', 'OBS HALL 8', 'IN3']);
    assert.deepEqual(r.tally.u2, { pgm: ['On air'], pvw: [] });
    assert.deepEqual(r.tally.u1, { pgm: [], pvw: ['Preview'] });
    assertAllRead('kairos', received);
    await assert.rejects(BY_ID.kairos.create({ host: '127.0.0.1', port, password: 'bad' }, quiet).read(), /login refused/);
  } finally { s.close(); srv.close(); }
});

// ---- engine with another machine: the state for the chosen input ----------------------------------

test('engine: the chosen input of a vMix, by its key; every outbound message is a read', async () => {
  const out = [];
  const off = guard.onOutbound(m => out.push(m));
  let active = 2;
  const srv = net.createServer(c => {
    c.on('data', () => { const x = Buffer.from(`<vmix><version>27</version><edition>HD</edition><inputs><input key="a" number="1" title="CAM"/><input key="b" number="2" title="OBS"/></inputs><preview>1</preview><active>${active}</active></vmix>`); c.write(`XML ${x.length}\r\n`); c.write(x); });
  });
  const port = await listen(srv);
  const e = new TallyEngine(() => ({ device: 'vmix', host: '127.0.0.1', port, input: 'b', input_name: 'OBS' }), quiet);
  try {
    await until(() => e.snapshot().state === 'pgm');
    assert.equal(e.snapshot().state, 'pgm');
    assert.equal(e.snapshot().input, 'OBS');
    active = 1;
    await until(() => e.snapshot().state === 'none');
    assert.equal(e.snapshot().state, 'none');
    const r = await e.inputs();
    assert.deepEqual(r.inputs.map(i => i.id), ['a', 'b']);
    for (const m of out.filter(m => m.driver === 'vmix')) assert.ok(guard.allowed(BY_ID.vmix.RULES, m.msg), m.msg);
  } finally { off(); e.stop(); srv.close(); }
});

// ---- what the review found: no frozen tally, no second model, no crossed sessions ----------

test('Roland: another model (V-60HD...) is refused after VER, nothing else sent; a silent unit is no frozen tally', async () => {
  const got = [];
  let model = 'V-60HD', silent = false;
  const srv = net.createServer(c => {
    c.on('error', () => {});
    c.write('Enter password:');
    c.on('data', d => {
      for (const l of lines(String(d))) {
        got.push(l);
        if (l === '4321\n') c.write('Welcome to ' + model + '.\r\n');
        else if (l === 'VER;\n') c.write(`\x02VER:${model},1.00;`);
        else if (l.startsWith('RQH') && !silent) c.write('\x02DTH:0C0000,' + '01'.padEnd(32, '0') + ';');
      }
    });
  });
  const port = await listen(srv);
  try {
    const e = await BY_ID.roland.create({ host: '127.0.0.1', port, password: '4321' }, quiet).read().catch(x => x);
    assert.match(e.message, /not supported/); assert.equal(e.permanent, true);
    assert.deepEqual(got, ['4321\n', 'VER;\n']);                     // no tally read sent to it
    model = 'V-160HD';
    const s = BY_ID.roland.create({ host: '127.0.0.1', port, password: '4321' }, quiet);
    assert.deepEqual((await s.read()).tally['0'].pgm, ['PGM']);
    silent = true;                                                   // the unit stops answering, TCP still up
    await assert.rejects(s.read(), /no tally answer/);
    s.close();
  } finally { srv.close(); }
});

test('engine: Test connection while polling, two reads at once: one connection, no crossed sessions', async () => {
  let conns = 0, open = 0;
  const srv = net.createServer(c => {
    conns++; open++;
    c.on('close', () => { open--; });
    c.on('error', () => {});
    c.on('data', d => { for (const _ of lines(String(d))) { const x = Buffer.from('<vmix><inputs><input key="b" number="1" title="OBS"/></inputs><active>1</active></vmix>'); setTimeout(() => { c.write(`XML ${x.length}\r\n`); c.write(x); }, 30); } });
  });
  const port = await listen(srv);
  const e = new TallyEngine(() => ({ device: 'vmix', host: '127.0.0.1', port, input: 'b' }), quiet);
  try {
    await until(() => e.snapshot().state === 'pgm');
    for (let i = 0; i < 5; i++) { const t = await e.test(); assert.equal(t.ok, true, JSON.stringify(t)); }
    const [a, b] = await Promise.all([e.inputs(), e.debug()]);
    assert.equal(a.inputs.length, 1); assert.equal(b.tally.pgm[0], 'PGM');
    const s = BY_ID.vmix.create({ host: '127.0.0.1', port }, quiet);
    const before = conns;
    await Promise.all([s.read(), s.read()]);
    assert.equal(conns - before, 1);                                // one connection for two reads
    s.close();
    e.stop();
    await until(() => open === 0);
    assert.equal(open, 0);                                          // nothing left open
  } finally { e.stop(); srv.close(); }
});

test('engine: an unsupported model is not retried until the settings change', async () => {
  let logins = 0;
  const srv = net.createServer(c => {
    c.on('error', () => {});
    c.write('Enter password:');
    c.on('data', d => { const l = String(d); if (l === '4321\n') { logins++; c.write('Welcome to V-60HD.\r\n'); } else if (l === 'VER;\n') c.write('\x02VER:V-60HD,1.00;'); });
  });
  const port = await listen(srv);
  const cfg = { device: 'roland', host: '127.0.0.1', port, password: '4321', input: '0' };
  const e = new TallyEngine(() => cfg, quiet);
  try {
    await until(() => e.snapshot().error);
    assert.match(e.snapshot().error, /not supported/);
    await new Promise(r => setTimeout(r, 3800));                    // past the retry delay
    assert.equal(logins, 1);
  } finally { e.stop(); srv.close(); }
});

test('SCAN: nothing but a greeting or ONE GET is ever sent to a machine not known yet', async () => {
  // the scan lists: empty (listen only) or GET requests only
  const scanned = Object.values(BY_ID).filter(d => d.probe);
  assert.deepEqual(scanned.map(d => d.id).sort(), ['kairos', 'livecore', 'livepremier', 'pixelhue', 'roland', 'tricaster', 'vmix']);
  for (const d of scanned) {
    assert.equal(guard.rulesOf(d.id + '-scan'), d.SCAN_RULES, d.id);
    assert.ok(d.SCAN_RULES.length <= 1, `${d.id}: one scan read at most`);
    for (const r of d.SCAN_RULES) assert.match(r.desc, /^GET \//, d.id);
    for (const bad of ['?\n', 'list:\r\n', 'XML\r\n', 'VER;\n', '1234\n', 'POST / {}', 'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"getFrameSettings","params":{}}', 'GET /v1/shortcut?name=take'])
      assert.equal(guard.allowed(d.SCAN_RULES, bad), false, `${d.id} scan would send ${bad}`);
  }
  assert.ok(!BY_ID.atem.probe && !BY_ID.eventmaster.probe);            // not scanned: chosen in the list
  // probes against fake machines: what they send is in their scan list
  const got = { livecore: [], vmix: [], roland: [], kairos: [] };
  const servers = [];
  const tcp = (id, onConn) => { const v = net.createServer(c => { c.on('error', () => {}); onConn(c); c.on('data', d => got[id].push(...lines(String(d)))); }); servers.push(v); return listen(v); };
  const lc = await tcp('livecore', c => c.write('TPcon0,2\r\n'));
  const vm = await tcp('vmix', c => c.write('VERSION OK 27.0.0.1\r\n'));
  const ro = await tcp('roland', c => c.write('Enter password:'));
  const ka = http.createServer((q, res) => { got.kairos.push(`${q.method} ${q.url}`); res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kairos"' }); res.end(); });
  servers.push(ka);
  const kaPort = await listen(ka);
  assert.match((await BY_ID.livecore.probe('127.0.0.1', { port: lc })).model, /LiveCore/);
  assert.deepEqual(await BY_ID.vmix.probe('127.0.0.1', { port: vm }), { model: 'vMix 27.0.0.1' });
  assert.equal((await BY_ID.roland.probe('127.0.0.1', { port: ro })).needsAuth, true);
  assert.deepEqual(await BY_ID.kairos.probe('127.0.0.1', { port: kaPort }), { model: 'Panasonic KAIROS', needsAuth: true });
  assert.equal(got.livecore.length + got.vmix.length + got.roland.length, 0);    // nothing sent: their greeting is enough
  assert.deepEqual(got.kairos, ['GET /inputs']);
  servers.forEach(v => v.close());
});

// ---- STOP TALLY: nothing leaves -----------------------------------------------------------

test('STOP TALLY: the tally starts stopped; cut = no connection, no byte, open ones closed at once', async () => {
  const fresh = require('child_process').spawnSync(process.execPath, ['-e', "console.log(require('./src/tally/guard').isCut())"], { cwd: require('path').join(__dirname, '..') });
  assert.equal(String(fresh.stdout).trim(), 'true');                // a fresh start: CUT
  let conns = 0, http1 = 0, udp1 = 0;
  const tcp = net.createServer(c => { conns++; c.on('error', () => {}); c.write('VERSION OK 1\r\n'); c.on('data', () => { const x = Buffer.from('<vmix><inputs><input key="b" number="1" title="OBS"/></inputs><active>1</active></vmix>'); c.write(`XML ${x.length}\r\n`); c.write(x); }); });
  const tport = await listen(tcp);
  const hs = http.createServer((q, r) => { http1++; r.end('[]'); });
  const hport = await listen(hs);
  const us = dgram.createSocket('udp4'); us.on('message', () => { udp1++; });
  await new Promise(r => us.bind(0, '127.0.0.1', r));
  const e = new TallyEngine(() => ({ device: 'vmix', host: '127.0.0.1', port: tport, input: 'b' }), quiet);
  try {
    await until(() => e.snapshot().state === 'pgm');
    assert.ok(guard.liveCount() >= 1);
    e.setCut(true);                                                  // STOP TALLY
    assert.equal(e.snapshot().cut, true);
    assert.equal(guard.liveCount(), 0);                              // everything closed at once
    const before = conns;
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(conns, before);                                     // the engine no longer connects
    assert.equal(e.snapshot().state, null);
    // every way out is shut: TCP, HTTP, UDP, the scan, test, inputs
    await assert.rejects(BY_ID.vmix.create({ host: '127.0.0.1', port: tport }, quiet).read(), /stopped/);
    await assert.rejects(BY_ID.kairos.create({ host: '127.0.0.1', port: hport, password: 'x' }, quiet).read(), /stopped/);
    const a = BY_ID.atem.create({ host: '127.0.0.1', port: us.address().port }, quiet);
    await assert.rejects(a.read(), /./); a.close();
    await assert.rejects(require('../src/tally/index').scan({ hosts: ['127.0.0.1'] }), /stopped/);
    assert.equal(await guard.tcpOpen('127.0.0.1', tport, 300), false);
    assert.equal((await e.test()).ok, false);
    await assert.rejects(e.inputs(), /stopped/);
    assert.equal(conns, before); assert.equal(http1, 0); assert.equal(udp1, 0);
    e.setCut(false);                                                 // on again
    await until(() => e.snapshot().state === 'pgm');
    assert.equal(e.snapshot().state, 'pgm');
  } finally { e.stop(); guard.setCut(false); tcp.close(); hs.close(); us.close(); }
});
