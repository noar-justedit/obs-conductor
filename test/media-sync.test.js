'use strict';
// Media copy master -> slave through the app's HTTP server (real server,
// real files in temp folders; the "slave" puts the master folder elsewhere).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// /tmp, not os.tmpdir(): on a Mac the latter is /var/folders/..., which the
// media copy rightly refuses as a system folder (/var).
const tmp = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'obsc-media-'));
const obsDir = path.join(tmp, 'obs');
process.env.OBS_CONFIG_DIR = obsDir;
process.env.OBSCONDUCTOR_DATA_DIR = path.join(tmp, 'data');
const { startServer } = require('../src/server');
const { Store } = require('../src/store');
const { FakeObs } = require('../src/fake-obs');
const { MediaSync, archiveRootFor } = require('../src/media-sync');

const A = path.join(tmp, 'master', 'Media');       // the master's folder
const B = path.join(tmp, 'slave', 'Media');        // where it goes on the slave
const quiet = { info() {}, warn() {}, error() {} };
let server, port;

function writeCollection(files) {
  fs.mkdirSync(path.join(obsDir, 'basic', 'scenes'), { recursive: true });
  fs.writeFileSync(path.join(obsDir, 'basic', 'scenes', 'Show.json'), JSON.stringify({ name: 'Show',
    sources: files.map((f, i) => ({ id: 'ffmpeg_source', name: 'v' + i, settings: { local_file: f } })) }));
}
const mk = (name, content, mtime) => {
  const p = path.join(A, name); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content); if (mtime) fs.utimesSync(p, mtime, mtime); return p;
};
const fresh = () => ({ files_total: 0, files_done: 0, bytes_total: 0, bytes_done: 0, copied: 0, archived: 0, up_to_date: 0, busy: [], errors: [], need_folders: [] });
const sync = (password = 'pw') => {
  const state = fresh();
  const job = new MediaSync({ host: '127.0.0.1', port, password },
    { mappings: [{ from: A, to: B }], manifestFile: path.join(tmp, 'data', 'manifest.json'), log: quiet, state });
  return job.run().then(r => ({ ...r, state }));
};

test.before(async () => {
  fs.mkdirSync(path.join(obsDir, 'plugin_config', 'obs-websocket'), { recursive: true });
  fs.writeFileSync(path.join(obsDir, 'plugin_config', 'obs-websocket', 'config.json'),
    JSON.stringify({ server_enabled: true, server_port: 4455, server_password: 'pw', auth_required: true }));
  const obs = new FakeObs(); obs.collection = 'Show'; obs.collections = ['Show'];
  const app = { store: new Store(path.join(tmp, 'pl'), path.join(tmp, 'settings.yaml')), client: obs, simulate: false, log: quiet, ips: [], mediaListTtl: 0 };
  server = startServer(app, 0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});
test.after(() => server.close());

test('first copy, then up to date, then an update goes through the archive', async () => {
  const big = Buffer.alloc(3 << 20, 7);
  const f1 = mk('clip.mov', big, new Date('2026-01-01T10:00:00Z'));
  const f2 = mk(path.join('sub', 'logo.png'), 'PNG', new Date('2026-01-02T10:00:00Z'));
  writeCollection([f1, f2]);
  let r = await sync();
  assert.equal(r.state.copied, 2);
  assert.deepEqual(fs.readFileSync(path.join(B, 'clip.mov')), big);
  assert.equal(fs.readFileSync(path.join(B, 'sub', 'logo.png'), 'utf8'), 'PNG');
  assert.equal(Math.round(fs.statSync(path.join(B, 'clip.mov')).mtimeMs), Date.parse('2026-01-01T10:00:00Z'));

  r = await sync();
  assert.equal(r.state.copied, 0); assert.equal(r.state.up_to_date, 2);

  mk(path.join('sub', 'logo.png'), 'PNG v2', new Date('2026-02-01T10:00:00Z'));
  r = await sync();
  assert.equal(r.state.copied, 1); assert.equal(r.state.archived, 1);
  assert.equal(fs.readFileSync(path.join(B, 'sub', 'logo.png'), 'utf8'), 'PNG v2');
  const arch = archiveRootFor(path.join(B, 'sub', 'logo.png'), [{ from: A, to: B }]);
  assert.equal(arch, B + ' (archive)');
  const dated = fs.readdirSync(arch);
  assert.equal(fs.readFileSync(path.join(arch, dated[0], 'sub', 'logo.png'), 'utf8'), 'PNG');   // the old one, kept
});

test('a cut copy resumes where it stopped', async () => {
  const data = Buffer.from(Array.from({ length: 2 << 20 }, (_, i) => i % 251));
  const f = mk('long.mov', data, new Date('2026-03-01T10:00:00Z'));
  writeCollection([f, path.join(A, 'clip.mov'), path.join(A, 'sub', 'logo.png')]);
  fs.writeFileSync(path.join(B, 'long.mov.obsc-part'), data.subarray(0, 1 << 20));   // half of it, from an earlier try
  const r = await sync();
  assert.equal(r.state.copied, 1);
  assert.deepEqual(fs.readFileSync(path.join(B, 'long.mov')), data);
  assert.ok(!fs.existsSync(path.join(B, 'long.mov.obsc-part')));
});

test('a file the master no longer uses goes to the archive; wrong password refused; only scene media served', async () => {
  writeCollection([path.join(A, 'clip.mov'), path.join(A, 'long.mov')]);   // logo.png dropped
  const r = await sync();
  assert.equal(r.state.archived, 1);
  assert.ok(!fs.existsSync(path.join(B, 'sub', 'logo.png')));
  await assert.rejects(sync('nope'), /wrong password/);
  const http = require('http');
  const auth = require('../src/auth');
  const target = '/api/media/file?' + new URLSearchParams({ path: path.join(obsDir, 'plugin_config', 'obs-websocket', 'config.json') });
  const get = sig => new Promise(res => http.get({ host: '127.0.0.1', port, path: target,
    headers: { [auth.HEADER]: sig } }, r => { r.resume(); res(r.statusCode); }));
  assert.equal(await get(auth.sign('pw', target)), 403);                 // signed right, but not a media of the scenes
  assert.equal(await get(auth.sign('pw', '/api/media/file')), 401);      // signature of another address
});

test('a master drive missing here asks for a folder', () => {
  const files = [{ path: 'Q:\\Show\\a.mov', size: 1, mtime: 0 }, { path: path.join(A, 'clip.mov'), size: 1, mtime: 0 }];
  if (process.platform !== 'win32') assert.deepEqual(MediaSync.unresolvedRoots(files, []), ['Q:\\Show']);
  assert.deepEqual(MediaSync.unresolvedRoots(files, [{ from: 'Q:\\Show', to: 'E:\\x' }]), []);
});

test('network share paths: the share is the top folder, mappings follow it', () => {
  const C = require('../src/collection');
  assert.equal(C.mediaRoot('\\\\NAS\\media\\show\\a.mov'), '\\\\NAS\\media');
  const m = [{ from: '\\\\NAS\\media', to: 'E:\\Show' }];
  assert.equal(C.mapPath('\\\\NAS\\media\\show\\a.mov', m), 'E:\\Show\\show\\a.mov');
});

test('time left: estimated from the bytes really fetched, 0 at the end', async () => {
  const data = Buffer.from(Array.from({ length: 4 << 20 }, (_, i) => (i * 7) % 253));
  const f = mk('eta.mov', data, new Date('2026-04-01T10:00:00Z'));
  writeCollection([f, path.join(A, 'clip.mov'), path.join(A, 'long.mov')]);
  fs.writeFileSync(path.join(B, 'eta.mov.obsc-part'), data.subarray(0, 2 << 20));   // half fetched before
  // a slow clock: every reading is one second later (last test: the
  // server's caches in this process see that clock too)
  const realNow = Date.now; let t = realNow();
  Date.now = () => (t += 1000);
  const seen = [];
  const state = new Proxy(fresh(), { set(o, k, v) { o[k] = v; if (k === 'eta_s' || k === 'speed') seen.push([k, v, o.bytes_done]); return true; } });
  try {
    const job = new MediaSync({ host: '127.0.0.1', port, password: 'pw' },
      { mappings: [{ from: A, to: B }], manifestFile: path.join(tmp, 'data', 'manifest.json'), log: quiet, state });
    await job.run();
  } finally { Date.now = realNow; }
  assert.equal(state.copied, 1);
  // the half already here arrives at once: no speed from it
  const first = seen.find(([k]) => k === 'speed');
  assert.equal(first[1], 0); assert.equal(first[2], 2 << 20);
  const etas = seen.filter(([k, v]) => k === 'eta_s' && v != null).map(([, v]) => v);
  assert.ok(etas.some(v => v > 0), 'a time left while copying');
  assert.equal(state.eta_s, 0);
});
