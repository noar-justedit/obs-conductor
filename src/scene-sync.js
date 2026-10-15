'use strict';
/*
 * Slave: "Sync" - copies the master's media onto this PC (media-sync.js),
 * then the master's general OBS settings (obs-settings.js: canvas, FPS,
 * colour, audio), then takes the master's scene collection and opens it in this PC's OBS,
 * under "<master's collection> (from master)", with the media paths moved
 * when a master folder goes elsewhere here.
 *
 * The files the collection uses but this PC still lacks are listed, and so
 * are the source / filter / transition kinds this OBS doesn't know (a plugin
 * installed on the master only).
 *
 * The master's OBS writes its collection file a moment after each change:
 * a change made in the last second may be missing - sync again.
 */

const fs = require('fs');
const crypto = require('crypto');
const C = require('./collection');
const path = require('path');
const auth = require('./auth');
const paths = require('./paths');
const { MediaSync } = require('./media-sync');
const obsSettings = require('./obs-settings');

const fresh = running => ({
  running, phase: running ? 'fetch' : null, error: null, finished_at: null,
  collection: null, scenes: 0, missing: [], unknown_kinds: [], unchanged: false,
  // media
  media: false, need_folders: [], master_missing: [], files_total: 0, files_done: 0, bytes_total: 0, bytes_done: 0,
  speed: 0, eta_s: null, current: null, copied: 0, archived: 0, up_to_date: 0, busy: [], errors: [],
  // general OBS settings
  obs_changed: [], obs_restart: false, obs_error: null,
});

const KNOWN_BUILTIN = new Set(['scene', 'group']);

class SceneSync {
  constructor(local, getConfig, log, store) {
    this.local = local;            // this PC's OBS
    this.getConfig = getConfig;    // slave config: master host, password, ports
    this.log = log;
    this.store = store;
    this.state = fresh(false);
    this._cancel = false;
    this.mediaJob = null;
  }

  cancel() {
    this._cancel = true;
    if (this.mediaJob) this.mediaJob.cancel();
  }

  snapshot() { return { ...this.state }; }

  /** What to sync (each true by default): opts.media, opts.obs (general
   *  OBS settings), opts.scenes. */
  start(opts = {}) {
    if (this.state.running) return false;
    this.state = fresh(true);
    this.state.media = opts.media !== false;
    this.state.obs = opts.obs !== false;
    this.state.scenes_part = opts.scenes !== false;
    if (!this.state.media && !this.state.obs && !this.state.scenes_part) { this.state = fresh(false); return false; }
    this.state.auto = !!opts.auto;
    this._cancel = false;
    this._run().catch(e => {
      this.log.error(`Scene sync: ${e.message}`);
      Object.assign(this.state, { running: false, phase: 'error', error: e.message, finished_at: Date.now() });
    });
    return true;
  }

  async _fetchFingerprint(cfg) {
    const p = '/api/scenes/fingerprint';
    const r = await fetch(`http://${cfg.master_host}:${cfg.master_dashboard_port || 8090}${p}`, {
      headers: { [auth.HEADER]: auth.sign(cfg.master_obs_password, p) }, signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.fingerprint) throw new Error(j.error || `master answered HTTP ${r.status}`);
    return j.fingerprint;
  }

  /**
   * "Auto sync": called every few seconds while the master is linked. When
   * the master's scenes or media changed since the last complete Sync, a
   * Sync starts by itself. A Sync that didn't finish clean (file in use,
   * error) is tried again 30 s later at the earliest.
   */
  async autoCheck() {
    if (this.state.running || this._checking) return;
    this._checking = true;
    try {
      const cfg = this.getConfig();
      if (!cfg.auto_sync || !cfg.master_host || !this.local.connected) return;
      const fp = await this._fetchFingerprint(cfg);
      if (fp === this.store.lastMasterFingerprint()) return;
      if (this._lastAuto && this._lastAuto.fp === fp && Date.now() - this._lastAuto.at < 30000) return;
      this._lastAuto = { fp, at: Date.now() };
      this.log.info('Auto sync: the master changed - syncing');
      this.start({ media: true, auto: true });
    } catch (_) {
      // master away: the link watch deals with it
    } finally { this._checking = false; }
  }

  async _fetchObsSettings(cfg) {
    const p = '/api/obs/settings';
    const r = await fetch(`http://${cfg.master_host}:${cfg.master_dashboard_port || 8090}${p}`, {
      headers: { [auth.HEADER]: auth.sign(cfg.master_obs_password, p) }, signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return null;                 // master in 1.3.0 or before: nothing to copy
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.video) throw new Error(j.error || `master answered HTTP ${r.status}`);
    return j;
  }

  async _copyObsSettings(cfg) {
    this.state.phase = 'obs';
    try {
      const master = await this._fetchObsSettings(cfg);
      if (!master) return;
      const r = await obsSettings.apply(this.local, master, this.log);
      Object.assign(this.state, { obs_changed: r.changed, obs_restart: r.restart, obs_error: r.error });
    } catch (e) {
      this.state.obs_error = `OBS settings not read: ${e.message}`;
      this.log.warn(`Sync: ${this.state.obs_error}`);
    }
  }

  async _fetchCollection(cfg) {
    const p = '/api/scenes/collection';
    const r = await fetch(`http://${cfg.master_host}:${cfg.master_dashboard_port || 8090}${p}`, {
      headers: { [auth.HEADER]: auth.sign(cfg.master_obs_password, p) },
      signal: AbortSignal.timeout(20000),
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (r.status === 401) throw new Error('the master refused: wrong password (link the master again)');
    if (!r.ok || !j.collection) throw new Error(j.error || `master answered HTTP ${r.status}`);
    return j;
  }

  async _unknownKinds(data) {
    const want = new Set(C.sourceKinds(data));
    for (const s of data.sources || []) for (const f of s.filters || []) if (f && f.id) want.add(f.versioned_id || f.id);
    const known = new Set(KNOWN_BUILTIN);
    const add = async (req, key, extra) => {
      try { for (const k of (await this.local.call(req, extra))[key] || []) known.add(k); } catch (_) {}
    };
    await add('GetInputKindList', 'inputKinds', { unversioned: false });
    await add('GetInputKindList', 'inputKinds', { unversioned: true });
    await add('GetTransitionKindList', 'transitionKinds');
    await add('GetSourceFilterKindList', 'sourceFilterKinds');
    if (known.size <= KNOWN_BUILTIN.size) return [];   // this OBS can't tell: don't guess
    return [...want].filter(k => !known.has(k) && !known.has(k.replace(/_v\d+$/, '')));
  }

  async _run() {
    const cfg = this.getConfig();
    if (!cfg.master_host) throw new Error('no master yet');
    if (!this.local.connected) throw new Error("this PC's OBS is not connected");

    const mappings = this.store.mediaMappings();
    // the master's fingerprint now: kept if this Sync completes clean
    let masterFp = null;
    try { masterFp = await this._fetchFingerprint(cfg); } catch (_) {}
    if (this.state.media) {
      this.state.phase = 'media';
      this.mediaJob = new MediaSync(
        { host: cfg.master_host, port: cfg.master_dashboard_port || 8090, password: cfg.master_obs_password },
        { mappings, manifestFile: path.join(paths.userDataDir(), 'media-manifest.json'), log: this.log,
          state: this.state, cancelled: () => this._cancel });
      try {
        const r = await this.mediaJob.run();
        if (r.need_folders) {
          this.log.info(`Sync: a folder is needed here for ${r.need_folders.join(', ')}`);
          Object.assign(this.state, { running: false, phase: 'need_folders', finished_at: Date.now() });
          return;
        }
      } finally { this.mediaJob = null; }
      this.log.info(`Media sync: ${this.state.copied} copied, ${this.state.up_to_date} up to date, ${this.state.archived} archived` +
        (this.state.busy.length ? `, ${this.state.busy.length} in use (next Sync)` : '') +
        (this.state.errors.length ? `, ${this.state.errors.length} error(s)` : ''));
    }

    this._check();
    if (this.state.obs) await this._copyObsSettings(cfg);
    if (!this.state.scenes_part) { this._done(masterFp); return; }

    this.state.phase = 'fetch';
    const j = await this._fetchCollection(cfg);
    const data = C.rewritePaths(j.collection, mappings);
    const name = `${j.name || data.name || 'Master'}${C.SUFFIX}`;
    // what changes at every scene switch doesn't count (collection.fingerprint)
    const hash = C.fingerprint(data);
    this.state.collection = name;
    this.state.scenes = C.sceneNames(data).length;

    this.state.phase = 'check';
    this.state.missing = C.mediaPaths(data).filter(p => !fs.existsSync(p));
    this.state.unknown_kinds = await this._unknownKinds(data);

    const cur = await this.local.call('GetSceneCollectionList');
    if (cur.currentSceneCollectionName === name && this.store.lastSceneSync() === hash) {
      this.log.info(`Scene sync: "${name}" already up to date`);
      this._done(masterFp, { unchanged: true });
      return;
    }

    this._check();
    this.state.phase = 'load';
    this.log.info(`Scene sync: loading "${name}" (${this.state.scenes} scenes) from ${cfg.master_name || cfg.master_host}`);
    await C.loadIntoObs(this.local, name, data, this.log);
    this.store.setLastSceneSync(hash);
    if (this.state.missing.length) this.log.warn(`Scene sync: ${this.state.missing.length} media file(s) missing here, e.g. ${this.state.missing[0]}`);
    if (this.state.unknown_kinds.length) this.log.warn(`Scene sync: unknown here (plugin missing?): ${this.state.unknown_kinds.join(', ')}`);
    this._done(masterFp);
  }

  /** Cancelled, or this PC is no longer a slave: stop before touching OBS. */
  _check() {
    if (this._cancel) throw new Error('Cancelled');
    if (!this.getConfig().enabled) throw new Error('this PC is no longer a slave');
  }

  _done(masterFp, extra = {}) {
    // the master's fingerprint covers all three: kept only after a full, clean Sync
    const clean = this.state.media && this.state.obs && this.state.scenes_part &&
      !this.state.busy.length && !this.state.errors.length && !this.state.obs_error;
    if (clean && masterFp) this.store.setLastMasterFingerprint(masterFp);
    Object.assign(this.state, { running: false, phase: 'done', finished_at: Date.now(), ...extra });
  }
}

module.exports = { SceneSync };
