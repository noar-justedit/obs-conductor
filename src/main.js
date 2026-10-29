'use strict';
/*
 * OBS Conductor - companion app behind the OBS dock (Windows, macOS, Linux).
 *
 * Runs in the background on every machine, master or slave:
 * - serves the dock page and its API (server.js) on http://localhost:8090
 * - plays the active playlist: each scene goes on air for its duration,
 *   with the playlist's default transition or the one forced on the row
 * - as a slave, follows its master instead (follower.js); the master is
 *   found on the network by discovery.js
 * - Windows: shows an icon in the notification area, with notifications
 *   (tray.js); macOS: an icon in the menu bar, no notifications (tray.js,
 *   installer/mac/menubar.m); Linux: no icon, the dock says it all
 * - installed copy, first run: adds the dock to OBS when OBS is closed
 *   (obs-setup.js), once
 *
 * Timing lives here, not in the dock: closing or reloading the dock in OBS
 * never interrupts playback. If OBS is closed or restarts, the connection
 * comes back on its own and the scene that should be on air is sent again.
 *
 *   node src/main.js              normal, drives the local OBS
 *   node src/main.js --simulate   fake OBS, to try the dock without OBS
 *   node src/main.js --stop       stops the app running on this PC
 *   node src/main.js --add-dock   adds the dock to OBS (OBS closed), now
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const P = require('./player');
const { Store } = require('./store');
const OBS = require('./obs');
const { FakeObs } = require('./fake-obs');
const { MasterFollower, MasterMonitor } = require('./follower');
const { Tray, Notes } = require('./tray');
const { SceneSync } = require('./scene-sync');
const { InstallerInfo, Updater } = require('./update');
const { TallyEngine } = require('./tally/index');
const { startServer } = require('./server');
const obsSetup = require('./obs-setup');

const MAX_SLEEP_MS = 100;   // the loop checks at least 10 times a second
const LINK_LOST_MS = 3000;  // slave: master away this long -> fallback scene
const LINK_BACK_MS = 2000;  // slave: master back this long -> follow it again
const AUTO_SYNC_EVERY_MS = 5000;   // slave with "Auto sync": how often it asks the master

const stamp = () => {
  const d = new Date();
  return d.toLocaleString('sv-SE') + '.' + String(d.getMilliseconds()).padStart(3, '0');   // local time
};
// Installed, the app runs hidden (no window): everything also goes to
// <user data>/logs/OBSConductor.log, see paths.js (over 5 MB: moved to
// OBSConductor.old.log and a new one is started).
let logFd = null, logPath = '';
function openLogFile() {
  if (!paths.isPackaged()) return;
  try {
    const dir = path.join(paths.userDataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = logPath = path.join(dir, 'OBSConductor.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 5e6) fs.renameSync(f, path.join(dir, 'OBSConductor.old.log'));
    logFd = fs.openSync(f, 'a');
  } catch (_) { logFd = null; }
}
const out = (line, err) => {
  try { (err ? console.error : console.log)(line); } catch (_) {}   // run hidden: maybe no console
  if (logFd !== null) try { fs.writeSync(logFd, line + '\r\n'); } catch (_) {}
};
const log = {
  info: m => out(`${stamp()} [INFO] ${m}`),
  warn: m => out(`${stamp()} [WARNING] ${m}`),
  error: m => out(`${stamp()} [ERROR] ${m}`, true),
};

const isLocal = h => ['localhost', '127.0.0.1', '::1', ''].includes(String(h || '').toLowerCase());

/** OBS on this PC: its WebSocket port and password are read from OBS's own
 *  settings, so nobody has to copy them by hand. Copied into settings.yaml
 *  when they change (the Settings panel then shows "password set"). */
function obsCredentials(store) {
  return cfg => {
    if (!isLocal(cfg.host)) return;
    const ws = obsSetup.readWebsocket();
    if (!ws) return;
    if (ws.port === cfg.port && ws.password === cfg.password) return;
    cfg.port = ws.port; cfg.password = ws.password;
    try { store.setGeneralSettings({ obs: { port: ws.port, password: ws.password } }); } catch (_) {}
    log.info(`OBS WebSocket settings read from OBS (port ${ws.port}${ws.enabled ? '' : ', server switched OFF in OBS: Tools > WebSocket Server Settings'})`);
  };
}

const now = () => performance.now() / 1000;   // monotonic clock, seconds
// OBS answers "not ready" (code 207) for a moment while it is busy (loading
// a scene collection, starting): wait a little and ask again, up to ~3 s.
const isNotReady = e => e instanceof OBS.ObsRequestError && e.code === 207;
async function notReadyRetry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!isNotReady(e) || i >= 10) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
}
const fmtClock = s => { s = Math.max(0, Math.ceil(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** This machine's LAN addresses, shown in the dock so the slave knows what
 *  to type. */
function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

class Companion {
  constructor(simulate) {
    this.simulate = simulate;
    this.log = log;
    this.store = new Store(paths.playlistsDir(), paths.settingsPath());
    const o = this.store.obsConfig();
    if (simulate) {
      this.client = new FakeObs(null, log);
      log.warn('SIMULATION MODE - no real OBS, scene changes are only logged');
    } else {
      this.client = new OBS.ObsClient({ host: o.host, port: o.port, password: o.password, label: 'OBS',
                                        beforeConnect: obsCredentials(this.store) });
      this.client.on('connected', () => { log.info('OBS connected'); this._resendOnAir().finally(() => this.wake()); });
      this.client.on('disconnected', why => log.warn(`OBS connection lost (${why}) - playback resumes once it's back`));
      this.client.start();
    }

    if (!this.store.listPlaylists().length) this.store.savePlaylist('default', P.emptyPlaylist());
    if (!this.store.exists(this.store.activePlaylistName())) {
      this.store.setActivePlaylistName(this.store.listPlaylists()[0]);
    }

    this.player = new P.Player();
    this.loaded = [null, null];     // [playlist name, revision]
    this.retry = null;              // switch that failed because OBS was away
    this.lastError = null;
    this.wasSlave = false;
    this.ips = localIps();
    this.version = require('../package.json').version;
    this._timer = null;
    this._busy = false;

    this.follower = new MasterFollower(() => this.store.slaveConfig(), this.client, log);
    this.monitor = new MasterMonitor(() => this.store.slaveConfig());
    this.sceneSync = new SceneSync(this.client, () => this.store.slaveConfig(), log, this.store);
    // versions: this PC's installer for its slaves, the master's for a slave
    this.installer = new InstallerInfo(this.version);
    this.updater = new Updater(this.version, () => {
      const c = this.store.slaveConfig();
      return c.enabled && c.master_host ? { host: c.master_host, port: c.master_dashboard_port || 8090, password: c.master_obs_password } : null;
    }, log, { simulate });

    // tally: is this PC's OBS on air on the switcher? (Settings > Tally;
    // reads only, see tally/guard.js)
    this.tally = new TallyEngine(() => this.store.tallyConfig(), log);
    this.notes = new Notes();
    // OBS on this PC: ok | off (WebSocket server switched off in OBS) |
    // closed (OBS not running) | auth (password refused) | unreachable | unknown
    this.local = { ws: simulate ? 'ok' : 'unknown', obs_running: null };
    this.link = { status: null, since: 0, notified: null, fallback: false };
    this._watchTimer = setInterval(() => this._watch(), 2000);
    this._linkTimer = setInterval(() => this._watchLink().catch(e => log.error(`Link: ${e.message}`)), 500);
    setTimeout(() => this._watch(), 300);
  }

  // -- OBS on this PC, master link: state + notifications ------------------

  async _watch() {
    if (this._watching) return;
    this._watching = true;
    try {
      const prev = this.local.ws;
      let ws = 'ok', running = null;
      if (!this.simulate && !this.client.connected) {
        const cfg = obsSetup.readWebsocket();
        running = await obsSetup.isObsRunningAsync();          // null: can't tell
        if (running === false) ws = 'closed';
        else if (cfg && !cfg.enabled) ws = 'off';
        else if (/password/i.test(this.client.lastError || '')) ws = 'auth';
        else ws = cfg ? 'unreachable' : 'unknown';
        // just switched on in OBS: connect now rather than at the next retry
        if (prev === 'off' && ws !== 'off') this.client.reconnectNow();
      }
      this.local = { ws, obs_running: running };
      if (running === false) this._hookObsOnce();
      if (ws !== prev) {
        if (ws === 'off') {
          this.notes.add('OBS WebSocket is off', 'OBS > Tools > WebSocket Server Settings.', 'warning');
        } else if (ws === 'auth') {
          this.notes.add('OBS refused the password', 'Restart OBS.', 'warning');
        } else if (ws === 'ok' && (prev === 'off' || prev === 'auth')) {
          this.notes.add('Connected to OBS', '');
        }
      }
    } catch (e) {
      log.error(`Watch: ${e.message}`);
    } finally { this._watching = false; }
  }

  /**
   * Installed copy, OBS closed, dock never added: adds it, switches on OBS's
   * WebSocket server and copies its password (obs-setup.js). Done once: a
   * dock the user removes from OBS later stays removed (--add-dock puts it
   * back). OBS never started by this user (no settings yet): tried again
   * a minute later.
   */
  _hookObsOnce() {
    if (this.simulate || !paths.isPackaged() || this.store.obsHooked() || this._hookTried === 'never') return;
    if (Date.now() - (this._hookAt || 0) < 60000) return;
    this._hookAt = Date.now();
    const rc = obsSetup.main('install');
    if (rc === 0) {
      log.info('Dock added to OBS (first run)');
      this.notes.add('Dock added to OBS', 'Open OBS: Docks > OBS Conductor.');
      this.client.reconnectNow();
    } else if (rc === 1) {
      this._hookTried = 'never';   // an error: not every 2 s (see install.log)
      log.warn('Could not add the dock to OBS - see install.log');
    }
  }

  /**
   * Slave: the link to the master is its OBS (scenes) AND its app (playlist).
   * Lost for 3 s: notification, the slave stops following and goes to its
   * fallback scene (Settings), if one is set. Back for 2 s: it follows the
   * master again (and catches up its scene at once).
   */
  async _watchLink() {
    const cfg = this.store.slaveConfig();
    if (!cfg.enabled || !cfg.master_host) {
      if (this.link.fallback) this.follower.paused = false;
      if (this.backup) { this.backup.stop(); this.backup = null; this.retry = null; }
      this.link = { status: null, since: 0, notified: null, fallback: false };
      return;
    }
    const f = this.follower.snapshot(), m = this.monitor.snapshot();
    if (m.reachable) { this._checkVersion(); this._masterPlayback(m); }
    const st = f.status === 'connected' && m.reachable ? 'ok' : (/password/i.test(f.error || '') ? 'auth' : 'lost');
    if (st !== this.link.status) this.link = { ...this.link, status: st, since: Date.now() };
    const name = cfg.master_name || cfg.master_host;
    const lasting = Date.now() - this.link.since;
    if (st !== 'ok' && lasting > LINK_LOST_MS && this.link.notified !== st) {
      this.link.notified = st;
      if (st === 'auth') this.notes.add('Master refused the password', name, 'error');
      else this.notes.add('Master connection lost', name + (cfg.fallback_mode === 'continue' ? ' · playing on alone'
        : cfg.fallback_scene ? ` · fallback: ${cfg.fallback_scene}` : ''), 'error');
      log.warn(`Master ${name} lost (${f.status === 'connected' ? 'its app' : 'its OBS'} not reachable)`);
      if (!this.link.fallback) {
        this.link.fallback = true;
        this.follower.paused = true;     // nothing from the master until it's back
        if (cfg.fallback_mode === 'continue') this._playOnAlone(m);
        else if (cfg.fallback_scene) await this._goFallback(cfg.fallback_scene, this._masterPlayback(m));
      }
    } else if (st === 'ok' && !this.link.fallback && cfg.auto_sync && Date.now() - (this._autoAt || 0) > AUTO_SYNC_EVERY_MS) {
      this._autoAt = Date.now();
      this.sceneSync.autoCheck();
    } else if (st === 'ok' && this.link.fallback && lasting > LINK_BACK_MS) {
      this.link.fallback = false;
      this.link.notified = 'ok';
      if (this.backup) { this.backup.stop(); this.backup = null; this.retry = null; this.wake(); }
      this.follower.paused = false;
      this.notes.add('Master back', name);
      log.info(`Master ${name} back - following it again`);
      this.follower.checkDrift().catch(() => {});
    }
  }

  /** Slave: the master's version (every 30 s), a notification when it differs. */
  _checkVersion() {
    this.updater.check().then(r => {
      if (!r || !r.version || r.version === this.version || this._versionNoted === r.version) return;
      this._versionNoted = r.version;
      const u = this.updater.snapshot();
      this.notes.add(u.newer ? `Master is v${r.version}` : `Master is older (v${r.version})`,
        u.newer ? (u.available ? 'Update this PC from the dock.' : `This PC: v${this.version}`) : 'Update the master.', 'warning');
      log.warn(`Versions differ: master v${r.version}, this PC v${this.version}`);
    }).catch(() => {});
  }

  /** Master lost, "keep playing": the slave plays on the master's playlist
   *  from where the master was (its last known state), driving its own OBS. */
  _playOnAlone(m) {
    const st = m.state, pl = m.playlist && m.playlist.playlist;
    const p = st && st.player;
    if (!pl || !p || p.state !== P.PLAYING || !p.item_id) { log.info('Master lost while not playing: nothing to play on'); return; }
    const backup = new P.Player();
    const pb = this._masterPlayback(m);
    // the master's defaults (its playlist already carries them; its state is fresher)
    backup.setPlaylist(P.normalize(pb ? { ...pl, default_transition: pb.default_transition, default_duration: pb.default_duration } : pl));
    this.backupPlayback = pb;
    const age = Date.now() / 1000 - (st.fetched_at || Date.now() / 1000);   // how old that state is
    if (!backup.resume(now(), p.item_id, (p.remaining || 0) - age, p.loops || 0)) { log.warn('Master lost: its cue on air is not in its playlist'); return; }
    this.backup = backup;
    this.retry = null;
    this.backupName = m.state.active_playlist;
    log.info(`Master lost: playing on "${this.backupName}" alone, from "${p.scene}"`);
    this.wake();
  }

  /** Slave: the master's Settings > Playback, as last seen (this PC's own
   *  are hidden on a slave). Null when never seen (master older than 1.3.0). */
  _masterPlayback(m) {
    const pb = m && m.state && m.state.playback;
    if (pb) this._lastMasterPlayback = pb;
    return this._lastMasterPlayback || null;
  }

  _restartMedia(player) {
    if (player === this.backup && this.backupPlayback) return !!this.backupPlayback.restart_media_on_switch;
    return !!this.store.playbackConfig().restart_media_on_switch;
  }

  async _goFallback(scene, pb) {
    try {
      await OBS.switchScene(this.client, scene, (pb && pb.default_transition) || this.store.defaultTransition(), log);
      log.info(`Fallback scene on air: ${scene}`);
    } catch (e) {
      log.error(`Fallback scene "${scene}" could not be shown: ${e.message}`);
    }
  }

  /** What the tray icon shows (GET /api/tray). */
  trayInfo(since) {
    const role = this.store.role();
    const ws = this.local.ws;
    const obsTxt = { ok: 'OBS connected', off: 'OBS WebSocket off', closed: 'OBS closed', auth: 'OBS password refused',
                     unreachable: 'OBS not reachable', unknown: 'OBS not connected' }[ws] || '';
    const line1 = `${role ? role.toUpperCase() : 'Choose master or slave'}${this.store.locked() ? ' (locked)' : ''} - ${obsTxt}`;
    let line2 = '', linkBad = false;
    if (role === 'slave') {
      const cfg = this.store.slaveConfig();
      const name = cfg.master_name || cfg.master_host;
      const f = this.follower.snapshot();
      linkBad = !!cfg.master_host && (f.status !== 'connected' || !!this.link.fallback);
      line2 = !cfg.master_host ? 'No master yet' : (linkBad ? `Master ${name} unreachable` : `Following ${name}`);
    } else {
      const p = this.player.snapshot(now());
      if (p.state === P.PLAYING) line2 = `On air: ${p.scene} (-${fmtClock(p.remaining)})`;
    }
    // icon dot: green all good, orange needs a look, red connection lost
    const sync = this.sceneSync.snapshot();
    const u = this.updater.snapshot();
    const versionDiff = !!u.master && u.master !== u.local;
    if (role === 'slave' && versionDiff && !linkBad) line2 += ` · master v${u.master}`;
    let level = 'tray_ok';
    if (!role) level = 'app';
    else if (ws !== 'ok' && ws !== 'off') level = 'tray_error';
    else if (linkBad) level = 'tray_error';
    else if (ws === 'off' || (role === 'slave' && sync.phase === 'done' && ((sync.busy || []).length || (sync.errors || []).length))
             || (role === 'slave' && (sync.phase === 'error' || sync.phase === 'need_folders'))
             || (role === 'slave' && versionDiff)) level = 'tray_warn';
    const tooltip = ('OBS Conductor - ' + line1).slice(0, 63);   // Windows limit
    return { tooltip, line1, line2, level, notes: this.notes.since(since) };
  }

  setRole(role) {
    this.store.setRole(role);
    if (role === 'slave' && this.isPlaying()) { this.player.stop(); this.retry = null; }
    // no longer a slave: a Sync under way must not load the old master's scenes here
    if (role !== 'slave') { this.sceneSync.cancel(); this.updater.cancel(); }
    log.info(`This PC is now ${role.toUpperCase()}`);
    this.wake();
    this.follower.check();
  }

  quit() {
    log.info('Quit requested (tray icon, dock or --stop)');
    // the tray icon is not killed: it sees the app gone and removes itself
    // cleanly (a killed one leaves a ghost icon until hovered)
    setTimeout(() => process.exit(0), 200);
  }

  // -- called by the HTTP API ----------------------------------------

  isPlaying() { return this.player.state === P.PLAYING; }

  play(index) {
    this._reloadIfChanged();
    this.player.play(now(), index);
    this.lastError = null;
    this.wake();
  }

  stop() {
    this.player.stop();
    this.retry = null;
    this.lastError = null;
    log.info('Playback stopped');
    this.wake();
  }

  next() { this.player.next(now()); this.wake(); }

  state() {
    const slave = this.store.slaveConfig();
    const st = {
      server_time: Date.now() / 1000,
      role: this.store.role(),                  // '' = not chosen yet
      locked: this.store.locked(),
      version: this.version,
      simulated: this.simulate,
      platform: process.platform,   // the dock words a few things per system (Start menu...)
      obs: { connected: !!this.client.connected, error: this.client.lastError || null, ws: this.local.ws },
      active_playlist: this.loaded[0],
      playlist_rev: this.loaded[1],
      player: this.player.snapshot(now()),
      error: this.lastError,
      local_ips: this.ips,
      tally: this.tally.snapshot(),
      // Settings > Playback: a slave that lost this master plays with these
      playback: { default_transition: this.store.defaultTransition(), default_duration: this.store.defaultDuration(),
                  restart_media_on_switch: !!this.store.playbackConfig().restart_media_on_switch },
    };
    if (this.store.role() === 'slave') {     // also in free run (not following)
      st.follow = this.follower.snapshot();
      st.master = this.monitor.snapshot();
      st.master_link = { host: slave.master_host, name: slave.master_name, obs_port: slave.master_obs_port,
                         lost: !!this.link.fallback, fallback_scene: slave.fallback_scene || '',
                         fallback_mode: slave.fallback_mode === 'continue' ? 'continue' : 'scene',
                         auto_sync: !!slave.auto_sync, free_run: !!slave.free_run };
      if (this.backup) st.backup = { playlist: this.backupName, player: this.backup.snapshot(now()) };
      st.scene_sync = this.sceneSync.snapshot();
      st.update = this.updater.snapshot();
    }
    return st;
  }

  // -- playback loop --------------------------------------------------

  _reloadIfChanged() {
    const name = this.store.activePlaylistName();
    const rev = this.store.revision(name);
    if (name !== this.loaded[0] || rev !== this.loaded[1]) {
      // the general defaults first: the cue on air keeps its right length
      const pl = this.store.loadPlaylist(name);
      pl.default_transition = this.store.defaultTransition();
      pl.default_duration = this.store.defaultDuration();
      this.player.setPlaylist(pl);
      this.loaded = [name, rev];
      log.info(`Playlist "${name}" loaded (${pl.items.length} items, ${P.totalDuration(pl).toFixed(1)} s)`);
    }
  }

  /** OBS came back (restarted) during a cue: it reopened on the scene saved
   *  in its file, maybe not the one on air. Put the cue's scene back. */
  async _resendOnAir() {
    const player = this.backup || (this.store.slaveConfig().enabled ? null : this.player);
    if (!player || player.state !== P.PLAYING || this.retry) return;
    const p = player.snapshot(now());
    if (!p.scene) return;
    try {
      const cur = await this.client.call('GetCurrentProgramScene');
      if ((cur.currentProgramSceneName || cur.sceneName) === p.scene) return;
      log.warn(`OBS is back on "${cur.currentProgramSceneName || cur.sceneName}": putting "${p.scene}" back on air`);
      // the transition the cue was put on air with (its own, or the playlist default)
      const cue = player.current || {};
      const transition = cue.transition || player.playlist.default_transition;
      if (player === this.player) this.retry = { scene: p.scene, transition, itemId: p.item_id };
      else await this._execute({ scene: p.scene, transition }, player);
    } catch (_) { /* OBS gone again: the next connection tries again */ }
  }

  async _execute(sw, player = this.player) {
    const { scene } = sw;
    try {
      const scenes = await notReadyRetry(() => OBS.listScenes(this.client));
      if (!scenes.includes(scene)) {
        log.error(`Scene "${scene}" does not exist in OBS - skipped`);
        this.lastError = `Scene "${scene}" not found in OBS - skipped`;
        if (sw.itemId) player.skipMissing(now(), scene);
        return;
      }
      await notReadyRetry(() => OBS.switchScene(this.client, scene, sw.transition, log));
      if (this._restartMedia(player)) await OBS.restartMediaInScene(this.client, scene);
      const t = sw.transition || {};
      log.info(`On air -> ${scene}  (${t.name} ${t.duration_ms} ms)`);
      this.retry = null;
      this.lastError = null;           // a switch went through: an old error no longer applies
    } catch (e) {
      if (e instanceof OBS.ObsUnavailable || isNotReady(e)) {
        log.warn(`OBS unavailable, "${scene}" will be sent once it's back (${e.message})`);
        this.retry = sw;
      } else {
        log.error(`Could not put "${scene}" on air: ${e.message}`);
        this.lastError = `Could not put "${scene}" on air: ${e.message}`;
      }
    }
  }

  async _step() {
    const slave = !!this.store.slaveConfig().enabled;
    if (slave && !this.wasSlave && this.isPlaying()) {
      log.info('Switched to slave mode - local playback stopped');
      this.player.stop();
      this.retry = null;
    }
    this.wasSlave = slave;
    if (slave) {
      // a slave plays nothing itself, except its master's playlist while the
      // master is lost ("keep playing" fallback)
      if (!this.backup) { this.retry = null; return; }
      let sw = this.backup.tick(now());
      if (!sw && this.retry && this.client.connected) {
        // OBS is back: send what should be on air now (as the master does)
        sw = this.retry;
        if (sw.itemId && sw.itemId !== this.backup.itemId) { sw = null; this.retry = null; }
      }
      for (let guard = 0; sw && guard < 50; guard++) {
        await this._execute(sw, this.backup);
        sw = this.retry ? null : this.backup.tick(now());
      }
      return;
    }

    this._reloadIfChanged();
    // default transition and duration are general settings (live)
    this.player.setDefaults(this.store.defaultTransition(), this.store.defaultDuration());
    let sw = this.player.tick(now());
    if (!sw && this.retry && this.client.connected) {
      // OBS is back: send what should be on air now
      sw = this.retry;
      if (sw.itemId && sw.itemId !== this.player.itemId) { sw = null; this.retry = null; }
    }
    for (let guard = 0; sw && !slave && guard < 50; guard++) {
      await this._execute(sw);
      // a skipped scene queues the next item: send it now, not next turn
      sw = this.retry ? null : this.player.tick(now());
    }
  }

  wake() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._loop(), 0);
  }

  async _loop() {
    clearTimeout(this._timer);
    if (this._busy) { this._timer = setTimeout(() => this._loop(), 5); return; }
    this._busy = true;
    try { await this._step(); }
    catch (e) { log.error(`Playback loop: ${e.stack || e.message}`); }
    finally { this._busy = false; }
    const deadline = (this.backup || this.player).nextDeadline();
    const ms = deadline == null ? MAX_SLEEP_MS : Math.min(MAX_SLEEP_MS, Math.max(0, (deadline - now()) * 1000));
    this._timer = setTimeout(() => this._loop(), ms);
  }
}

/** --stop: asks the app running on this PC to quit. */
async function stopRunning() {
  const s = new Store(paths.playlistsDir(), paths.settingsPath()).settings();
  const port = parseInt((s.dashboard || {}).port, 10) || 8090;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(3000) });
    console.log(r.ok ? 'OBS Conductor stopped' : `OBS Conductor answered HTTP ${r.status}`);
    return r.ok ? 0 : 1;
  } catch (_) { console.log('OBS Conductor is not running'); return 0; }
}

function main() {
  if (process.argv.includes('--stop')) { stopRunning().then(code => process.exit(code)); return; }
  if (process.argv.includes('--add-dock')) { paths.ensureDefaultConfig(); process.exit(obsSetup.main('install')); }
  openLogFile();
  log.info(`=== OBS Conductor ${require('../package.json').version} starting (Node ${process.versions.node}, ${process.platform}) ===`);
  paths.ensureDefaultConfig();
  if (paths.isPackaged()) obsSetup.loaderPage();   // the dock's page, kept up to date
  // Windows 2.3.0: "start with Windows" is for every user now (HKLM). The
  // per-user entry of an older install would start it twice: removed.
  if (process.platform === 'win32' && paths.isPackaged()) {
    const { execFile } = require('child_process');
    const RUN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    execFile('reg', ['query', `HKLM\\${RUN}`, '/v', 'OBS Conductor'], { windowsHide: true }, e => {
      if (!e) execFile('reg', ['delete', `HKCU\\${RUN}`, '/v', 'OBS Conductor', '/f'], { windowsHide: true }, () => {});
    });
  }
  const simulate = process.argv.includes('--simulate');
  // the simulated OBS keeps its scene collection files in a temp folder
  if (simulate && !process.env.OBS_CONFIG_DIR) process.env.OBS_CONFIG_DIR = path.join(os.tmpdir(), 'obs-conductor-sim-obs');
  const app = new Companion(simulate);
  const dash = app.store.settings().dashboard || {};
  let port = parseInt(dash.port, 10) || 8090;
  if (!(port >= 1024 && port <= 65535)) { log.warn(`Dock port ${dash.port} can't be used: 8090 instead`); port = 8090; }
  const bind = String(dash.bind || '0.0.0.0');
  app.listening = { port, bind };
  startServer(app, port, bind);
  log.info(`Dock page: http://localhost:${port}/  (in OBS: Docks > OBS Conductor)`);
  app.wake();
  const role = app.store.role();
  app.notes.add('OBS Conductor is running', role ? role.toUpperCase() : 'Choose master or slave in the OBS dock.');
  app.tray = new Tray({ port, log, logFile: logPath });
  app.tray.start();
  const bye = () => { app.tray.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

if (require.main === module) main();

module.exports = { Companion };
