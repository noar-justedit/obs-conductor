'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-scenes-'));
process.env.OBS_CONFIG_DIR = tmp;
const C = require('../src/collection');
const auth = require('../src/auth');
const { FakeObs } = require('../src/fake-obs');

test('signature: right password and address only, 2 minutes', () => {
  const h = auth.sign('pw', '/api/scenes/collection', 1000000);
  assert.ok(auth.verify(h, 'pw', '/api/scenes/collection', 1000000 + 60000));
  assert.ok(!auth.verify(h, 'other', '/api/scenes/collection', 1000000));
  assert.ok(!auth.verify(h, 'pw', '/api/media/file', 1000000));
  assert.ok(!auth.verify(h, 'pw', '/api/scenes/collection', 1000000 + 3 * 60000));   // 2 minutes
  // the query counts: a signature for one file can't fetch another
  const f = auth.sign('pw', '/api/media/file?path=a', 1000000);
  assert.ok(auth.verify(f, 'pw', '/api/media/file?path=a', 1000000));
  assert.ok(!auth.verify(f, 'pw', '/api/media/file?path=b', 1000000));
  // 1.5.x signature: only for the update
  const crypto = require('crypto');
  const old = t => p => `${t}.${crypto.createHmac('sha256', 'pw').update(`${t}${p}`).digest('base64url')}`;
  assert.ok(auth.verify(old(1000000)('/api/update/installer'), 'pw', '/api/update/installer', 1000000));
  assert.ok(!auth.verify(old(1000000)('/api/scenes/collection'), 'pw', '/api/scenes/collection', 1000000));
  assert.ok(!auth.verify('', 'pw', '/x'));
  assert.ok(auth.verify('', '', '/x'));                  // OBS without password
});

test('media paths, kinds and scenes of a collection', () => {
  const j = { sources: [
    { id: 'scene', name: 'A' },
    { id: 'ffmpeg_source', versioned_id: 'ffmpeg_source', settings: { local_file: 'D:/m/a.mov' } },
    { id: 'vlc_source', settings: { playlist: [{ value: 'E:\\b.mp4' }, { value: 'not a path' }] } },
    { id: 'image_source', settings: { file: 'D:/m/logo.png' } },
  ], transitions: [{ id: 'fade_transition' }] };
  assert.deepEqual(C.mediaPaths(j).sort(), ['D:/m/a.mov', 'D:/m/logo.png', 'E:\\b.mp4']);
  assert.deepEqual(C.sceneNames(j), ['A']);
  assert.ok(C.sourceKinds(j).includes('fade_transition'));
});

test('a collection is loaded into OBS without restarting it, first time and again', async () => {
  const obs = new FakeObs();                 // open: "Simulated collection"
  const master = { name: 'Show', sources: [{ id: 'scene', name: 'Intro', settings: { items: [] } },
                                           { id: 'scene', name: 'Cam', settings: { items: [] } }] };
  const r = await C.loadIntoObs(obs, 'Show (from master)', master);
  assert.equal(r.created, true);
  assert.equal(obs.collection, 'Show (from master)');
  assert.deepEqual(Object.keys(obs.scenes), ['Intro', 'Cam']);
  assert.ok(obs.collections.includes('Simulated collection'));     // the slave's own one is kept
  // second sync while it is open: switched away, rewritten, reopened
  master.sources.push({ id: 'scene', name: 'Outro', settings: { items: [] } });
  const r2 = await C.loadIntoObs(obs, 'Show (from master)', master);
  assert.equal(r2.created, false);
  assert.deepEqual(Object.keys(obs.scenes), ['Intro', 'Cam', 'Outro']);
  const saved = JSON.parse(fs.readFileSync(C.findCollectionFile('Show (from master)'), 'utf8'));
  assert.equal(saved.name, 'Show (from master)');
});
