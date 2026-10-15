'use strict';
// The master sends its scene items' positions / sizes as OBS has them now,
// not only as its .json file says (OBS doesn't save a move or a resize).
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/collection');

const file = () => ({
  name: 'Show',
  sources: [
    { id: 'scene', name: 'Intro', settings: { items: [
      { id: 1, name: 'Clip', pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rot: 0, align: 5, bounds_type: 0,
        bounds: { x: 0, y: 0 }, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0,
        pos_rel: { x: -1.7, y: -1 }, scale_rel: { x: 1, y: 1 }, scale_ref: { x: 1920, y: 1080 }, bounds_rel: { x: 0, y: 0 } },
      { id: 2, name: 'Logo', pos: { x: 10, y: 10 }, scale: { x: 1, y: 1 } },
    ] } },
    { id: 'scene', name: 'Broken', settings: { items: [{ id: 1, name: 'X', pos: { x: 5, y: 5 } }] } },
    { id: 'ffmpeg_source', name: 'Clip', settings: { local_file: 'D:/a.mov' } },
  ],
});

const client = {
  async call(type, d) {
    if (d.sceneName === 'Broken') throw new Error('no such scene');
    assert.equal(type, 'GetSceneItemList');
    return { sceneItems: [
      { sceneItemId: 1, sceneItemTransform: { positionX: 480, positionY: 270, scaleX: 0.5, scaleY: 0.5, rotation: 0, alignment: 5,
        boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: 960, boundsHeight: 540,
        cropLeft: 4, cropTop: 0, cropRight: 0, cropBottom: 0, cropToBounds: false } },
    ] };
  },
};

test('live positions and sizes replace the ones of the file', async () => {
  const out = await C.withLiveTransforms(client, file());
  const [clip, logo] = out.sources[0].settings.items;
  assert.deepEqual(clip.pos, { x: 480, y: 270 });
  assert.deepEqual(clip.scale, { x: 0.5, y: 0.5 });
  assert.equal(clip.bounds_type, 2);
  assert.deepEqual(clip.bounds, { x: 960, y: 540 });
  assert.equal(clip.crop_left, 4);
  // the stale canvas-relative copies would win in OBS: removed
  assert.equal(clip.pos_rel, undefined);
  assert.equal(clip.scale_rel, undefined);
  assert.equal(clip.bounds_rel, undefined);
  assert.equal(clip.name, 'Clip');
  // an item OBS didn't report keeps the file's values
  assert.deepEqual(logo.pos, { x: 10, y: 10 });
});

test('a scene OBS cannot list keeps the file, other sources untouched', async () => {
  const f = file();
  const out = await C.withLiveTransforms(client, f);
  assert.deepEqual(out.sources[1], f.sources[1]);
  assert.deepEqual(out.sources[2], f.sources[2]);
  assert.deepEqual(f.sources[0].settings.items[0].pos, { x: 0, y: 0 });   // the input is not modified
});

test('a live move changes the fingerprint (auto sync sees it)', async () => {
  const before = C.fingerprint(file());
  const after = C.fingerprint(await C.withLiveTransforms(client, file()));
  assert.notEqual(before, after);
});
