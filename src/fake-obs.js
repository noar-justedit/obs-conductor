'use strict';
/*
 * Fake OBS, for testing without OBS: `OBSConductor.exe app\src\main.js
 * --simulate` (or `npm run simulate`). The dock, the playlist engine and
 * the whole app run as in production; scene changes are only logged.
 *
 * Edit SCENES below to mirror a real scene collection.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ObsRequestError } = require('./obs');

// scene -> [[video source, length in seconds or null]]. null = a video OBS
// can't give a length for (file not loaded). [] = no video (camera, graphics).
const SCENES = {
  'Opening': [['Opening clip', 12.48]],
  'Live Cam': [],
  'Sponsor Loop': [['Background loop', 60], ['Sponsor spot', 20]],
  'Interview': [],
  'Ad Break': [['Ad reel', 31.2]],
  'Standby': [['Standby loop', null]],
};

// Media files of the simulated sources: D:/Media/<source>.mov, or real files
// in OBSCONDUCTOR_SIM_MEDIA (to try the media copy between two simulations).
const simMediaPath = src => process.env.OBSCONDUCTOR_SIM_MEDIA
  ? path.join(process.env.OBSCONDUCTOR_SIM_MEDIA, `${src}.mov`) : `D:/Media/${src}.mov`;

// media length by source name (to rebuild scenes read from a collection file)
const SCENE_MEDIA = Object.fromEntries(Object.values(SCENES).flat().map(([src, d]) => [src, d]));

const TRANSITIONS = [
  { transitionName: 'Cut', transitionFixed: true },
  { transitionName: 'Fade', transitionFixed: false },
  { transitionName: 'Swipe', transitionFixed: false },
  { transitionName: 'Stinger', transitionFixed: true },
];

class FakeObs extends EventEmitter {
  constructor(scenes, log) {
    super();
    this.scenes = { ...(scenes || SCENES) };
    this.current = Object.keys(this.scenes)[0] || null;
    this.transition = 'Fade';
    this.transitionMs = 300;
    this.collection = 'Simulated collection';
    this.collections = ['Simulated collection'];
    this.connected = true;
    this.lastError = null;
    this.switchLog = [];   // [scene, transition, ms]
    this.mediaLog = [];    // [input, action]
    this.log = log;
    this.cfg = { label: 'simulated OBS' };
    // scene collection files, like OBS (only with OBS_CONFIG_DIR: tests, --simulate)
    this.fileBacked = !!process.env.OBS_CONFIG_DIR;
    // general settings (canvas, FPS, profile values): kept in sim-profile.json
    this.profile = { video: { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 },
                     params: { 'Video.ColorFormat': 'NV12', 'Video.ColorSpace': '709', 'Audio.SampleRate': '48000' } };
    this.outputActive = false;
    if (this.fileBacked) try { Object.assign(this.profile, JSON.parse(fs.readFileSync(this._profileFile(), 'utf8'))); } catch (_) {}
  }

  _profileFile() { return path.join(process.env.OBS_CONFIG_DIR, 'sim-profile.json'); }
  _saveProfile() {
    if (!this.fileBacked) return;
    try { fs.mkdirSync(process.env.OBS_CONFIG_DIR, { recursive: true }); fs.writeFileSync(this._profileFile(), JSON.stringify(this.profile, null, 1)); } catch (_) {}
  }

  /** The open collection as OBS would write it (scenes + their media). */
  collectionJson() {
    const sources = [];
    for (const [scene, items] of Object.entries(this.scenes)) {
      sources.push({ id: 'scene', versioned_id: 'scene', name: scene, settings: {
        items: items.map(([src]) => ({ name: src })) } });
      for (const [src] of items) {
        sources.push({ id: 'ffmpeg_source', versioned_id: 'ffmpeg_source', name: src,
          settings: { local_file: simMediaPath(src) }, filters: [] });
      }
    }
    return { name: this.collection, current_scene: this.current, sources, transitions: [] };
  }

  _collectionFile(name) {
    const { scenesDir, findCollectionFile } = require('./collection');
    return findCollectionFile(name) || path.join(scenesDir(), name.replace(/[^\p{L}\p{N}_-]/gu, '_') + '.json');
  }

  _saveCollection() {
    if (!this.fileBacked || !this.collection) return;
    const f = this._collectionFile(this.collection);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(this.collectionJson(), null, 4));
  }

  _openCollection(name) {
    this.collection = name;
    if (!this.fileBacked) return;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this._collectionFile(name), 'utf8')); } catch (_) {}
    this.scenes = {};
    for (const src of (data && data.sources) || []) {
      if (src.id === 'scene') this.scenes[src.name] = ((src.settings && src.settings.items) || []).map(i => [i.name, (SCENE_MEDIA[i.name] ?? null)]);
    }
    this.current = (data && data.current_scene) || Object.keys(this.scenes)[0] || null;
  }

  start() { return this; }
  stop() {}

  _fail(type, comment) { throw new ObsRequestError(type, { code: 600, comment }); }

  async call(type, d = {}) {
    switch (type) {
      case 'GetSceneList':
        return {
          currentProgramSceneName: this.current,
          scenes: Object.keys(this.scenes).map((sceneName, i, a) => ({ sceneName, sceneIndex: a.length - 1 - i })),
        };
      case 'GetCurrentProgramScene':
        return { currentProgramSceneName: this.current, sceneName: this.current };
      case 'SetCurrentProgramScene':
        if (!(d.sceneName in this.scenes)) this._fail(type, `No source was found by the name of \`${d.sceneName}\`.`);
        this.current = d.sceneName;
        this.switchLog.push([d.sceneName, this.transition, this.transitionMs]);
        if (this.log) this.log.info(`[simulated OBS] program -> ${d.sceneName}  (${this.transition} ${this.transitionMs} ms)`);
        this.emit('event', 'CurrentProgramSceneChanged', { sceneName: d.sceneName });
        return {};
      case 'GetSceneItemList':
        if (!(d.sceneName in this.scenes)) this._fail(type, 'No such scene');
        return {
          sceneItems: this.scenes[d.sceneName].map(([src]) => ({
            sourceName: src, inputKind: 'ffmpeg_source', isGroup: false,
            sourceType: 'OBS_SOURCE_TYPE_INPUT', sceneItemEnabled: true,
          })),
        };
      case 'GetInputSettings':
        // the simulated background loops loop, like in a real show
        return { inputKind: 'ffmpeg_source', inputSettings: { local_file: simMediaPath(d.inputName), looping: /loop/i.test(d.inputName) } };
      case 'GetGroupSceneItemList':
        return { sceneItems: [] };
      case 'GetMediaInputStatus':
        for (const items of Object.values(this.scenes)) {
          for (const [src, dur] of items) {
            if (src === d.inputName) {
              return { mediaState: 'OBS_MEDIA_STATE_PLAYING', mediaDuration: dur ? dur * 1000 : null, mediaCursor: 0 };
            }
          }
        }
        return this._fail(type, 'No such input');
      case 'TriggerMediaInputAction':
        this.mediaLog.push([d.inputName, d.mediaAction]);
        if (this.log) this.log.info(`[simulated OBS] ${d.mediaAction} on ${d.inputName}`);
        return {};
      case 'GetSceneTransitionList':
        return { transitions: TRANSITIONS, currentSceneTransitionName: this.transition };
      case 'GetCurrentSceneTransition': {
        const fixed = TRANSITIONS.some(t => t.transitionName === this.transition && t.transitionFixed);
        return { transitionName: this.transition, transitionDuration: fixed ? null : this.transitionMs, transitionFixed: fixed };
      }
      case 'SetCurrentSceneTransition':
        if (!TRANSITIONS.some(t => t.transitionName === d.transitionName)) this._fail(type, 'No such transition');
        this.transition = d.transitionName;
        return {};
      case 'SetCurrentSceneTransitionDuration':
        this.transitionMs = d.transitionDuration;
        return {};
      case 'GetSceneCollectionList':
        return { currentSceneCollectionName: this.collection, sceneCollections: this.collections };
      case 'SetCurrentSceneCollection':
        if (!this.collections.includes(d.sceneCollectionName)) this._fail(type, 'No scene collection by that name');
        if (d.sceneCollectionName === this.collection) return {};
        this._saveCollection();
        this._openCollection(d.sceneCollectionName);
        if (this.log) this.log.info(`[simulated OBS] scene collection -> ${d.sceneCollectionName}`);
        return {};
      case 'CreateSceneCollection':
        if (this.collections.includes(d.sceneCollectionName)) this._fail(type, 'already exists');
        this._saveCollection();
        this.collections.push(d.sceneCollectionName);
        this.collection = d.sceneCollectionName;
        this.scenes = { Scene: [] }; this.current = 'Scene';   // a new collection: one empty scene
        return {};
      case 'GetInputKindList':
        return { inputKinds: d.unversioned ? ['ffmpeg_source', 'vlc_source', 'browser_source', 'image_source', 'text_gdiplus', 'color_source']
                                         : ['ffmpeg_source', 'vlc_source', 'browser_source', 'image_source', 'text_gdiplus_v3', 'color_source_v3'] };
      case 'GetTransitionKindList':
        return { transitionKinds: ['cut_transition', 'fade_transition', 'swipe_transition', 'obs_stinger_transition'] };
      case 'GetVideoSettings':
        return { ...this.profile.video };
      case 'SetVideoSettings':
        if (this.outputActive) this._fail(type, 'Video settings cannot be changed while an output is active.');
        Object.assign(this.profile.video, d);
        // like obs-websocket: the FPS is stored as a fraction
        Object.assign(this.profile.params, { 'Video.FPSType': '2', 'Video.FPSNum': String(d.fpsNumerator), 'Video.FPSDen': String(d.fpsDenominator) });
        this._saveProfile();
        if (this.log) this.log.info(`[simulated OBS] video -> ${d.baseWidth}x${d.baseHeight}, ${d.fpsNumerator}/${d.fpsDenominator} fps`);
        return {};
      case 'GetProfileParameter': {
        const DEFAULTS = { 'Video.ColorFormat': 'NV12', 'Video.ColorSpace': '709', 'Video.ColorRange': 'Partial', 'Video.ScaleType': 'bicubic',
                           'Video.SdrWhiteLevel': '300', 'Video.HdrNominalPeak': '1000',
                           'Video.FPSType': '0', 'Video.FPSCommon': '30', 'Video.FPSInt': '30', 'Video.FPSNum': '30', 'Video.FPSDen': '1', 'Audio.SampleRate': '48000', 'Audio.ChannelSetup': 'Stereo' };
        const k = `${d.parameterCategory}.${d.parameterName}`;
        return { parameterValue: this.profile.params[k] ?? null, defaultParameterValue: DEFAULTS[k] ?? null };
      }
      case 'SetProfileParameter': {
        const k = `${d.parameterCategory}.${d.parameterName}`;
        if (d.parameterValue == null) delete this.profile.params[k]; else this.profile.params[k] = String(d.parameterValue);
        this._saveProfile();
        return {};
      }
      case 'GetOutputList':
        return { outputs: [{ outputName: 'simple_stream', outputActive: this.outputActive }] };
      case 'GetSourceFilterKindList':
        return { sourceFilterKinds: ['color_filter_v2', 'crop_filter', 'chroma_key_filter_v2', 'mask_filter_v2'] };
      default:
        return this._fail(type, 'not simulated');
    }
  }
}

// What the network scan finds in simulation (see discovery.js)
const FAKE_NETWORK = {
  networks: ['192.168.1.x'],
  found: [
    { host: '192.168.1.10', name: 'REGIE-MASTER', obs: { port: 4455, version: '5.5.2', auth: true },
      app: { app: 'obs-conductor', name: 'REGIE-MASTER', role: 'master', version: '1.2.0', obs_port: 4455, dashboard_port: 8090 } },
    { host: '192.168.1.24', name: 'CAM-PC-2', obs: { port: 4455, version: '5.5.2', auth: true },
      app: { app: 'obs-conductor', name: 'CAM-PC-2', role: 'slave', version: '1.2.0', obs_port: 4455, dashboard_port: 8090 } },
    { host: '192.168.1.31', name: '', obs: { port: 4455, version: '5.4.2', auth: true }, app: null },
  ],
};

module.exports = { FakeObs, SCENES, FAKE_NETWORK };
