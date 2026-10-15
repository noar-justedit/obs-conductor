'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const OBS = require('../src/obs');
const { FakeObs } = require('../src/fake-obs');

test('reference video: longest shown, not looping; hidden and loops listed anyway', async () => {
  const obs = new FakeObs({ S: [['Background loop', 60], ['Clip', 12], ['Hidden clip', 90]] });
  const orig = obs.call.bind(obs);
  obs.call = async (type, d) => {
    const r = await orig(type, d);
    if (type === 'GetSceneItemList') r.sceneItems.forEach(it => { if (it.sourceName === 'Hidden clip') it.sceneItemEnabled = false; });
    return r;
  };
  const media = await OBS.sceneMedia(obs, 'S');
  assert.deepEqual(media.map(m => [m.source, m.loop, m.hidden]),
    [['Background loop', true, false], ['Clip', false, false], ['Hidden clip', false, true]]);
  assert.equal(OBS.referenceVideo(media).source, 'Clip');
  assert.equal(OBS.referenceVideo(media.filter(m => m.source !== 'Clip')), null);   // only a loop + a hidden one: default duration
});
