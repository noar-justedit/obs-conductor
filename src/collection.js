'use strict';
/*
 * OBS scene collections on disk, and loading one into OBS.
 *
 * obs-websocket can't export or import a scene collection: the only way to
 * copy one to another PC with everything in it (sources, filters, positions,
 * plugin settings, transitions) is its .json file in
 * %APPDATA%\obs-studio\basic\scenes. OBS reads that file each time it
 * switches to the collection, and writes the open one back when it switches
 * away or quits (checked in OBS's sources, OBSBasic_SceneCollections.cpp).
 *
 * loadIntoObs() relies on that, without restarting OBS:
 *   1. the collection doesn't exist yet: CreateSceneCollection (OBS creates
 *      it, empty, and opens it);
 *   2. if it is open, switch to another one: OBS saves it, closes it;
 *   3. write the master's content into its file;
 *   4. switch back to it: OBS reads the file.
 * The slave's own collections are never touched.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { obsDir } = require('./obs-setup');

const SUFFIX = ' (from master)';

const scenesDir = () => path.join(obsDir(), 'basic', 'scenes');

/** The .json file of a collection, matched on its "name" field (as OBS does). */
function findCollectionFile(name) {
  let files = [];
  try { files = fs.readdirSync(scenesDir()).filter(f => f.toLowerCase().endsWith('.json')); } catch (_) { return null; }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(scenesDir(), f), 'utf8'));
      if (data && data.name === name) return path.join(scenesDir(), f);
    } catch (_) {}
  }
  return null;
}

/** {name, file, data} of the collection open in OBS (data null if no file). */
async function currentCollection(client) {
  const r = await client.call('GetSceneCollectionList');
  const name = r.currentSceneCollectionName;
  const file = findCollectionFile(name);
  return { name, file, data: file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

// Keys holding a media file path, depending on the source kind.
const PATH_KEYS = new Set(['local_file', 'path', 'file']);
// VLC playlist entries store their path under a generic "value" key: only
// taken as a path when it looks like one.
const PATH_LIKE = /^(?:[a-zA-Z]:[\\/]|[\\/]).*\.[a-z0-9]{2,5}$/i;
const isMediaPath = (k, v) => typeof v === 'string' && !!v && (PATH_KEYS.has(k) || (k === 'value' && PATH_LIKE.test(v)));

/** Every media file path the collection uses. */
function mediaPaths(json) {
  const found = new Set();
  (function walk(node) {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) { if (isMediaPath(k, v)) found.add(v); else walk(v); }
    }
  })(json);
  return [...found];
}

// ---- where the master's media go on this PC ---------------------------------

const segs = p => String(p || '').split(/[\\/]+/);
const normKey = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The top folder of a path: "D:\\Media" for D:\\Media\\Show\\a.mov, "D:\\" for
 *  D:\\a.mov. macOS / Linux: the disk or the user's folder, which may not
 *  exist on another machine: /Volumes/SSD, /Users/noar, /home/noar,
 *  /media/noar/SSD, /run/media/noar/SSD, /mnt/nas; otherwise the first
 *  folder ("/data" for /data/x/a.mov). */
function mediaRoot(p) {
  // network share \\server\share\...: the share is the top folder
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(String(p || ''));
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
  const s = segs(p);
  const sep = String(p).includes('\\') ? '\\' : '/';
  if (/^[a-zA-Z]:$/.test(s[0])) return s.length > 2 ? s[0] + sep + s[1] : s[0] + sep;
  if (s[0] === '' && s.length > 2) {
    // how many folders make the root: /Volumes/SSD, /media/<user>/SSD...
    const deep = { Volumes: 2, Users: 2, home: 2, mnt: 2, media: 3 }[s[1]] || (s[1] === 'run' && s[2] === 'media' ? 4 : 1);
    const n = Math.min(deep, s.length - 2);   // never the file itself
    return '/' + s.slice(1, 1 + n).join('/');
  }
  return s[0] || '/';
}

/** Mapping {from, to} whose "from" folder holds p (the most precise wins). */
function mappingFor(p, mappings) {
  const k = normKey(p);
  let best = null;
  for (const m of mappings || []) {
    const f = normKey(m.from);
    if (f && (k === f || k.startsWith(f + '/')) && (!best || f.length > normKey(best.from).length)) best = m;
  }
  return best;
}

/** Master path -> path on this PC: unchanged unless a mapping moves it. */
function mapPath(p, mappings) {
  const m = mappingFor(p, mappings);
  if (!m || !m.to || normKey(m.to) === normKey(m.from)) return p;
  const rest = String(p).slice(String(m.from).replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
  const to = String(m.to).replace(/[\\/]+$/, '');
  const sep = to.includes('\\') || /^[a-zA-Z]:/.test(to) ? '\\' : '/';
  return rest ? to + sep + rest.replace(/[\\/]+/g, sep) : to;
}

/** The collection with every media path moved by the mappings. */
function rewritePaths(json, mappings) {
  if (!mappings || !mappings.length) return json;
  return (function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = isMediaPath(k, v) ? mapPath(v, mappings) : walk(v);
      return out;
    }
    return node;
  })(json);
}

// Keys OBS rewrites at every scene switch: not a change of the scenes.
const VOLATILE = ['current_scene', 'current_program_scene', 'current_transition', 'transition_duration',
  'preview_locked', 'scaling_enabled', 'scaling_level', 'scaling_off_x', 'scaling_off_y', 'saved_projectors'];

/** Fingerprint of what a slave copies: the scenes (minus what changes at
 *  every scene switch) and, if given, the media list (path, size, date). */
function fingerprint(json, mediaList) {
  const clean = { ...(json || {}) };
  for (const k of VOLATILE) delete clean[k];
  const h = crypto.createHash('sha256').update(JSON.stringify(clean));
  if (mediaList) h.update(JSON.stringify(mediaList.map(f => [f.path, f.size, f.mtime])));
  return h.digest('hex');
}

/** Source kinds ("id") used by the collection, e.g. ffmpeg_source, browser_source. */
function sourceKinds(json) {
  const kinds = new Set();
  for (const s of (json && json.sources) || []) if (s && s.id) kinds.add(s.versioned_id || s.id);
  for (const t of (json && json.transitions) || []) if (t && t.id) kinds.add(t.id);
  return [...kinds];
}

/** Scene names of a collection. */
const sceneNames = json => ((json && json.sources) || []).filter(s => s && s.id === 'scene').map(s => s.name);

// ---- positions and sizes as they are now in OBS ----------------------------

// obs-websocket names of the bounds types -> the numbers of the .json file
const BOUNDS_TYPES = { OBS_BOUNDS_NONE: 0, OBS_BOUNDS_STRETCH: 1, OBS_BOUNDS_SCALE_INNER: 2, OBS_BOUNDS_SCALE_OUTER: 3,
  OBS_BOUNDS_SCALE_TO_WIDTH: 4, OBS_BOUNDS_SCALE_TO_HEIGHT: 5, OBS_BOUNDS_MAX_ONLY: 6 };
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** One item of the file with the transform OBS reports now. */
function applyTransform(it, t) {
  const n = { ...it };
  if (isNum(t.positionX) && isNum(t.positionY)) n.pos = { x: t.positionX, y: t.positionY };
  if (isNum(t.scaleX) && isNum(t.scaleY)) n.scale = { x: t.scaleX, y: t.scaleY };
  if (isNum(t.rotation)) n.rot = t.rotation;
  if (isNum(t.alignment)) n.align = t.alignment;
  for (const [k, w] of [['cropLeft', 'crop_left'], ['cropTop', 'crop_top'], ['cropRight', 'crop_right'], ['cropBottom', 'crop_bottom']]) {
    if (isNum(t[k])) n[w] = t[k];
  }
  if (t.boundsType in BOUNDS_TYPES) n.bounds_type = BOUNDS_TYPES[t.boundsType];
  if (isNum(t.boundsAlignment)) n.bounds_align = t.boundsAlignment;
  if (isNum(t.boundsWidth) && isNum(t.boundsHeight)) n.bounds = { x: t.boundsWidth, y: t.boundsHeight };
  if (typeof t.cropToBounds === 'boolean') n.bounds_crop = t.cropToBounds;
  // OBS 30.1+ also writes canvas-relative copies, read first when present:
  // without them it reads the pixel values above
  delete n.pos_rel; delete n.scale_rel; delete n.bounds_rel;
  return n;
}

/**
 * The collection with each scene item's position, size, rotation, crop and
 * bounds as they are now in OBS. OBS doesn't write its .json file when an
 * item is moved or resized (only on other changes, a collection switch or
 * when it quits): the file alone may hold the old ones.
 * A scene OBS can't list keeps what the file says.
 */
async function withLiveTransforms(client, json) {
  if (!json || !Array.isArray(json.sources)) return json;
  const sources = [];
  for (const s of json.sources) {
    const items = s && (s.id === 'scene' || s.id === 'group') && s.settings && Array.isArray(s.settings.items) ? s.settings.items : null;
    if (!items || !items.length) { sources.push(s); continue; }
    let live = [];
    try {
      live = (await client.call(s.id === 'group' ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName: s.name })).sceneItems || [];
    } catch (_) { sources.push(s); continue; }
    const byId = new Map(live.filter(i => i && i.sceneItemTransform).map(i => [i.sceneItemId, i.sceneItemTransform]));
    if (!byId.size) { sources.push(s); continue; }
    sources.push({ ...s, settings: { ...s.settings, items: items.map(it => byId.has(it.id) ? applyTransform(it, byId.get(it.id)) : it) } });
  }
  return { ...json, sources };
}

/**
 * Puts `data` into OBS as the collection `name` and opens it (see header).
 * Returns {created}. OBS shows nothing for a moment while it reloads.
 */
async function loadIntoObs(client, name, data, log = { info() {} }) {
  const content = JSON.stringify({ ...data, name }, null, 4);
  let list = await client.call('GetSceneCollectionList');
  let created = false;
  if (!(list.sceneCollections || []).includes(name)) {
    await client.call('CreateSceneCollection', { sceneCollectionName: name });
    created = true;
    log.info(`Scene collection "${name}" created in OBS`);
    list = await client.call('GetSceneCollectionList');
  }
  if (list.currentSceneCollectionName === name) {
    let other = (list.sceneCollections || []).find(c => c !== name);
    if (!other) {
      // only this collection exists: make a spare one to step away to
      other = 'OBS Conductor (spare)';
      await client.call('CreateSceneCollection', { sceneCollectionName: other });
    } else {
      await client.call('SetCurrentSceneCollection', { sceneCollectionName: other });
    }
  }
  // OBS has written the file of the closed collection: replace its content
  const file = findCollectionFile(name);
  if (!file) throw new Error(`OBS did not save the scene collection "${name}" in ${scenesDir()}`);
  const tmp = file + '.obsp-tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  await client.call('SetCurrentSceneCollection', { sceneCollectionName: name });
  return { created, file };
}

module.exports = { SUFFIX, scenesDir, findCollectionFile, currentCollection, mediaPaths, sourceKinds, sceneNames, loadIntoObs,
  mediaRoot, mappingFor, mapPath, rewritePaths, fingerprint, withLiveTransforms };
