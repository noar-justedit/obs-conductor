'use strict';
/*
 * Playlists on disk (one YAML file each) + settings.yaml.
 *
 * settings.yaml is edited through the yaml library's document model, so
 * the comments in it survive when the dock changes a setting.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const P = require('./player');

const SLAVE_DEFAULTS = {
  enabled: false,              // kept in step with "role" (older files)
  master_host: '',
  master_name: '',             // the master PC's name, shown in the dock
  master_obs_port: 4455,
  master_obs_password: '',
  master_dashboard_port: 8090,
  fallback_scene: '',          // this PC's scene shown when the master is lost
  fallback_mode: 'scene',      // master lost: 'scene' (the fallback scene) or 'continue' (play on its playlist)
  auto_sync: false,            // Sync by itself when the master's scenes or media change
  free_run: false,             // the slave stops following its master, on its own (dock button)
};

const ROLES = ['master', 'slave'];

class Store {
  constructor(playlistsDir, settingsPath) {
    this.dir = playlistsDir;
    this.settingsPath = settingsPath;
    fs.mkdirSync(this.dir, { recursive: true });
    this._doc = null;
    this._stamp = null;
  }

  // -- playlists ------------------------------------------------------

  static safeName(name) {
    return String(name || '').replace(/[^\p{L}\p{N}\- _]/gu, '').trim();
  }

  playlistPath(name) { return path.join(this.dir, Store.safeName(name) + '.yaml'); }

  listPlaylists() {
    return fs.readdirSync(this.dir)
      .filter(f => f.toLowerCase().endsWith('.yaml'))
      .map(f => f.slice(0, -5))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  exists(name) { return !!Store.safeName(name) && fs.existsSync(this.playlistPath(name)); }

  /** Changes whenever the file is rewritten. */
  revision(name) {
    try {
      const st = fs.statSync(this.playlistPath(name));
      return `${st.mtimeMs}-${st.size}`;
    } catch (_) { return null; }
  }

  loadPlaylist(name) {
    try {
      return P.normalize(YAML.parse(fs.readFileSync(this.playlistPath(name), 'utf8')));
    } catch (_) {
      return P.emptyPlaylist();
    }
  }

  savePlaylist(name, data) {
    const pl = P.normalize(data);
    const file = this.playlistPath(name);
    const tmp = file + '.tmp';
    // write-then-rename: playback never reads a half-written file
    fs.writeFileSync(tmp, YAML.stringify(pl), 'utf8');
    fs.renameSync(tmp, file);
    return pl;
  }

  deletePlaylist(name) {
    try { fs.unlinkSync(this.playlistPath(name)); } catch (_) {}
    if (this.playlistFile(name)) this.setPlaylistFile(name, null);
  }

  /** A name not used yet: "Show", "Show 2", "Show 3"... */
  freeName(wanted) {
    const base = Store.safeName(wanted) || 'playlist';
    let name = base, n = 2;
    while (this.exists(name)) name = `${base} ${n++}`;
    return name;
  }

  /** Text of a playlist file (.obsplaylist): YAML, readable and editable. */
  exportText(name) {
    const pl = this.loadPlaylist(name);
    pl.default_transition = this.defaultTransition();
    pl.default_duration = this.defaultDuration();
    return '# OBS Conductor - playlist file\n' +
      YAML.stringify({ format: 'obs-playlist', version: 1, name, ...pl });
  }

  /** Reads a playlist file and adds it under a free name. Returns the name. */
  importText(text, fallbackName) {
    let data;
    try { data = YAML.parse(String(text || '')); } catch (e) { throw new Error(`not a playlist file (${e.message})`); }
    if (!data || (typeof data !== 'object')) throw new Error('not a playlist file');
    if (!Array.isArray(data) && !Array.isArray(data.items)) throw new Error('no scene list in this file');
    const name = this.freeName((!Array.isArray(data) && data.name) || fallbackName);
    const pl = P.normalize(data);
    pl.items.forEach(it => { it.id = P.newId(); });   // never share ids with another playlist
    this.savePlaylist(name, pl);
    return name;
  }

  renamePlaylist(oldName, newName) {
    fs.renameSync(this.playlistPath(oldName), this.playlistPath(newName));
    const f = this.playlistFile(oldName);
    this.setPlaylistFile(oldName, null);
    if (f) this.setPlaylistFile(newName, f);
  }

  /** The .obsplaylist file a playlist was last saved to / loaded from ("Save"
   *  writes there again without asking), or null. */
  playlistFile(name) {
    const m = this.settings().playlist_files || {};
    return typeof m[name] === 'string' && m[name] ? m[name] : null;
  }

  setPlaylistFile(name, file) {
    const m = { ...(this.settings().playlist_files || {}) };
    if (file) m[name] = String(file); else delete m[name];
    this._set(['playlist_files'], m);
  }

  // -- settings.yaml --------------------------------------------------

  _settingsDoc() {
    let st;
    try { st = fs.statSync(this.settingsPath); } catch (_) {
      return this._doc || new YAML.Document({});
    }
    const stamp = `${st.mtimeMs}-${st.size}`;
    if (stamp !== this._stamp || !this._doc) {
      try {
        const doc = YAML.parseDocument(fs.readFileSync(this.settingsPath, 'utf8'));
        if (doc.errors.length) throw doc.errors[0];
        this._doc = doc;
        this._stamp = stamp;
      } catch (_) {
        // a broken settings file must not take the app down: keep the last
        // good one, and put the broken file aside before anything is written
        // over it (a hand edit gone wrong is not lost)
        if (this._brokenStamp !== stamp) {
          this._brokenStamp = stamp;
          const d = new Date(), pad = n => String(n).padStart(2, '0');
          const aside = `${this.settingsPath}.broken-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
          try { fs.copyFileSync(this.settingsPath, aside); } catch (_) {}
        }
        if (!this._doc) this._doc = new YAML.Document({});
      }
    }
    return this._doc;
  }

  settings() { return this._settingsDoc().toJS() || {}; }

  _set(keyPath, value) {
    const doc = this._settingsDoc();
    if (!doc.contents) doc.contents = doc.createNode({});
    doc.setIn(keyPath, value);
    // whole or nothing: a power cut during the write can't leave half a file
    const tmp = `${this.settingsPath}.tmp`;
    fs.writeFileSync(tmp, doc.toString(), 'utf8');
    fs.renameSync(tmp, this.settingsPath);
    const st = fs.statSync(this.settingsPath);
    this._stamp = `${st.mtimeMs}-${st.size}`;
  }

  /** Lock mode: nothing can be changed, played or stopped until unlocked. */
  locked() { return this.settings().locked === true; }
  setLocked(on) { this._set(['locked'], !!on); }

  /** The dock was added to OBS once (main.js does it on the first run). */
  obsHooked() { return this.settings().obs_hooked === true; }
  setObsHooked(on) { this._set(['obs_hooked'], !!on); }

  activePlaylistName() { return this.settings().active_playlist || 'default'; }
  setActivePlaylistName(name) { this._set(['active_playlist'], Store.safeName(name)); }

  /** Default transition: a general setting, used by every playlist for
   *  the cues without a forced transition. */
  defaultTransition() {
    const t = this.settings().default_transition || {};
    const ms = parseInt(t.duration_ms, 10);
    return { name: String(t.name || 'Fade'), duration_ms: Number.isFinite(ms) && ms >= 0 ? ms : 500 };
  }

  /** Default scene duration (seconds): a general setting, used by every cue
   *  without a video reference or a typed duration. */
  defaultDuration() {
    const d = parseFloat(this.settings().default_duration);
    return Number.isFinite(d) && d >= P.MIN_DURATION ? d : P.DEFAULT_DURATION;
  }

  /** '' (not chosen yet: the dock asks), 'master' or 'slave'. Files written
   *  before 1.2 only have slave.enabled. */
  role() {
    const s = this.settings();
    if (ROLES.includes(s.role)) return s.role;
    return s.slave && s.slave.enabled ? 'slave' : '';
  }

  setRole(role) {
    if (!ROLES.includes(role)) throw new Error('role must be master or slave');
    this._set(['role'], role);
    this._set(['slave', 'enabled'], role === 'slave');
    this._set(['slave', 'free_run'], false);    // a new role starts following again
  }

  /** General settings shown in the dock's Settings panel. */
  generalSettings() {
    const d = this.settings().dashboard || {};
    return {
      dashboard: { port: parseInt(d.port, 10) || 8090, bind: d.bind || '0.0.0.0' },
      playback: this.playbackConfig(),
      default_transition: this.defaultTransition(),
      default_duration: this.defaultDuration(),
      tally: this.tallyPublic(),
    };
  }

  /** Tally (tally/): the switcher model (driver id), its address, its
   *  login when it has one, and its input that this PC's OBS feeds (id +
   *  name). Empty: no tally. Before 2.2 only PixelHue existed: a config
   *  without a model is a PixelHue one (input = its name). */
  tallyConfig() {
    const t = this.settings().tally || {};
    const host = String(t.host || '').trim();
    return { device: String(t.device || (host ? 'pixelhue' : '')).trim(), host,
             port: parseInt(t.port, 10) || null, api_port: parseInt(t.api_port, 10) || null,
             user: String(t.user || ''), password: String(t.password || ''),
             input: String(t.input || '').trim(), input_name: String(t.input_name || '').trim(),
             // outputs that do NOT count as on air (2.3.0: all count unless unticked)
             exclude_outputs: Array.isArray(t.exclude_outputs) ? t.exclude_outputs.map(String).slice(0, 64) : [] };
  }

  /** The same, as shown to the dock: the password never leaves this PC. */
  tallyPublic() {
    const { password, api_port, ...t } = this.tallyConfig();
    return { ...t, has_password: !!password };
  }

  /** The connection to OBS on this PC. Port and password come from OBS's own
   *  settings (main.js); kept here as a fallback. */
  obsConfig() {
    const o = this.settings().obs || {};
    return { host: o.host || 'localhost', port: parseInt(o.port, 10) || 4455,
             password: o.password && o.password !== 'YOUR_WEBSOCKET_PASSWORD' ? String(o.password) : '' };
  }

  setGeneralSettings(b) {
    b = b || {};
    if (b.obs) {
      if (b.obs.host != null) this._set(['obs', 'host'], String(b.obs.host).trim() || 'localhost');
      if (b.obs.port != null && parseInt(b.obs.port, 10)) this._set(['obs', 'port'], parseInt(b.obs.port, 10));
      if (typeof b.obs.password === 'string') this._set(['obs', 'password'], b.obs.password);
    }
    if (b.dashboard) {
      if (b.dashboard.port != null && parseInt(b.dashboard.port, 10)) {
        const port = parseInt(b.dashboard.port, 10);
        // a port the app can't open would stop it from starting (and the dock
        // with it): refused here (review 2.2.2)
        if (!(port >= 1024 && port <= 65535)) throw new Error('Dock port: 1024 to 65535');
        // the dock in OBS points at the port: added again with the new one
        // the next time OBS is closed (main.js)
        if (port !== (parseInt((this.settings().dashboard || {}).port, 10) || 8090)) this._set(['obs_hooked'], false);
        this._set(['dashboard', 'port'], port);
      }
      if (b.dashboard.bind === '0.0.0.0' || b.dashboard.bind === '127.0.0.1') this._set(['dashboard', 'bind'], b.dashboard.bind);
    }
    if (b.playback && 'restart_media_on_switch' in b.playback) {
      this._set(['playback', 'restart_media_on_switch'], !!b.playback.restart_media_on_switch);
    }
    if (b.default_transition && b.default_transition.name) {
      const ms = Math.max(0, parseInt(b.default_transition.duration_ms, 10) || 0);
      this._set(['default_transition'], { name: String(b.default_transition.name), duration_ms: ms });
    }
    if (b.tally) {
      const t = b.tally, cur = this.tallyConfig();
      // another model: the input chosen for the old one means nothing now
      if (t.device != null && String(t.device) !== cur.device) {
        this._set(['tally', 'device'], String(t.device).trim());
        this._set(['tally', 'input'], ''); this._set(['tally', 'input_name'], '');
        this._set(['tally', 'port'], null);
        // the login of one machine is never sent to another (review 2.2.2)
        this._set(['tally', 'user'], ''); this._set(['tally', 'password'], '');
        // another machine, other outputs: they all count again
        this._set(['tally', 'exclude_outputs'], []);
      }
      // an address is a name or an IP, nothing else (it goes into URLs)
      if (t.host != null) {
        const h = String(t.host).trim();
        if (h && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(h)) throw new Error('switcher address: an IP or a name only');
        // another machine: its password is asked again (review 2.2.2)
        if (h.toLowerCase() !== cur.host.toLowerCase()) this._set(['tally', 'password'], '');
        this._set(['tally', 'host'], h);
      }
      if (t.port !== undefined) {
        const n = parseInt(t.port, 10);
        this._set(['tally', 'port'], n >= 1 && n <= 65535 ? n : null);
      }
      if (t.user != null) this._set(['tally', 'user'], String(t.user));
      if (typeof t.password === 'string') this._set(['tally', 'password'], t.password);
      if (t.input != null) this._set(['tally', 'input'], String(t.input).trim());
      if (t.input_name != null) this._set(['tally', 'input_name'], String(t.input_name).trim());
      if (Array.isArray(t.exclude_outputs)) {
        this._set(['tally', 'exclude_outputs'], [...new Set(t.exclude_outputs.map(x => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 64));
      }
    }
    if (b.default_duration != null) {
      const d = P.cleanDuration(b.default_duration);
      if (d != null) this._set(['default_duration'], d);
    }
  }

  playbackConfig() {
    return { restart_media_on_switch: false, ...(this.settings().playback || {}) };
  }

  slaveConfig() {
    const raw = this.settings().slave || {};
    const cfg = {};
    for (const k of Object.keys(SLAVE_DEFAULTS)) cfg[k] = raw[k] != null ? raw[k] : SLAVE_DEFAULTS[k];
    cfg.auto_sync = cfg.auto_sync === true;
    cfg.free_run = cfg.free_run === true;
    cfg.enabled = this.role() === 'slave' && !cfg.free_run;   // free run: not following
    return cfg;
  }

  /** Slave: where master folders go here, [{from, to}] (a master drive that
   *  doesn't exist on this PC). Empty: every media at the same path. */
  /** Folders chosen on this PC for the master's ones, used or not. */
  savedMediaMappings() {
    const m = (this.settings().slave || {}).media_mappings;
    return Array.isArray(m) ? m.filter(x => x && x.from && x.to).map(x => ({ from: String(x.from), to: String(x.to) })) : [];
  }

  /**
   * Settings > Media location: 'same' (the master's paths, as they are) or
   * 'custom' (the folders chosen here). Not set yet: custom if a folder was
   * chosen before (versions up to 1.6.3), same otherwise.
   */
  mediaMode() {
    const m = (this.settings().slave || {}).media_mode;
    if (m === 'same' || m === 'custom') return m;
    return this.savedMediaMappings().length ? 'custom' : 'same';
  }

  /** 'same': the chosen folders are kept (back with 'custom'), not used. */
  setMediaMode(mode) {
    if (mode !== 'same' && mode !== 'custom') throw new Error("mode: 'same' or 'custom'");
    this._set(['slave', 'media_mode'], mode);
  }

  /** The folders in use: none when the media are where the master has them. */
  mediaMappings() { return this.mediaMode() === 'custom' ? this.savedMediaMappings() : []; }

  setMediaMapping(from, to) {
    const list = this.savedMediaMappings().filter(m => m.from.toLowerCase() !== String(from).toLowerCase());
    if (to) list.push({ from: String(from), to: String(to) });
    this._set(['slave', 'media_mappings'], list);
    // a folder chosen (Settings or the Sync's "folder needed"): custom
    if (to && this.mediaMode() !== 'custom') this._set(['slave', 'media_mode'], 'custom');
  }

  /** Fingerprint of the master's scene collection last loaded here. */
  lastSceneSync() { return (this.settings().slave || {}).last_scene_sync || ''; }
  /** The master's fingerprint (scenes + media) at the last complete Sync. */
  lastMasterFingerprint() { return (this.settings().slave || {}).last_master_fingerprint || ''; }
  setLastMasterFingerprint(f) { this._set(['slave', 'last_master_fingerprint'], String(f || '')); }
  setLastSceneSync(hash) { this._set(['slave', 'last_scene_sync'], String(hash || '')); }

  setSlaveConfig(partial) {
    for (const [k, v0] of Object.entries(partial || {})) {
      if (!(k in SLAVE_DEFAULTS) || k === 'enabled') continue;
      let v = v0;
      if (k.endsWith('_port')) { v = parseInt(v, 10); if (!Number.isFinite(v)) continue; }
      else if (k === 'auto_sync' || k === 'free_run') v = v === true || v === 'true';
      else v = String(v == null ? '' : v);
      this._set(['slave', k], v);
    }
  }
}

module.exports = { Store, SLAVE_DEFAULTS, ROLES };
