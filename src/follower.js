'use strict';
/*
 * Slave side - keeps this machine's OBS slaved to the master's.
 *
 * MasterFollower listens to the master's OBS (its websocket server):
 * - scene change: same scene here, with the transition (name + length) the
 *   master is using, whether its playlist or an operator made the change
 * - media action (play / pause / restart / stop / next / previous) on a
 *   source of the master: replayed on the same source here
 * - every 2 s the slave's program scene is checked against the master's
 *   and corrected with a cut (someone clicked on the slave, OBS restarted)
 *
 * Videos that start because their scene goes on air start on both machines
 * by themselves (OBS restarts them on activation): only explicit actions are
 * forwarded, otherwise each video would restart twice.
 *
 * MasterMonitor reads the master's companion app (HTTP) to show its playlist
 * and progress in the slave's dock, read-only.
 *
 * Alignment depends on the network: a few ms on a wired LAN, more on Wi-Fi.
 * It is not frame-accurate (no genlock).
 */

const { ObsClient, EVENTS, switchScene, currentProgramScene } = require('./obs');

const CHECK_EVERY_MS = 2000;
const DRIFT_GRACE_MS = 3000;   // no drift correction this soon after following a change

const MEDIA_ACTIONS = new Set([
  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS',
]);

class MasterFollower {
  /** getConfig() is read on every check: switching to slave mode or
   *  changing the master's address applies within seconds. */
  constructor(getConfig, local, log, { autoStart = true } = {}) {
    this.getConfig = getConfig;
    this.local = local;
    this.log = log;
    this.master = null;
    this.key = null;
    this.status = 'disabled';
    this.error = null;
    this.lastScene = null;
    this.lastEventAt = 0;
    this._busy = Promise.resolve();   // switches are serialized
    if (autoStart) this._timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  _serial(fn) {
    const p = this._busy.then(fn, fn);
    this._busy = p.catch(() => {});
    return p;
  }

  async _masterTransition() {
    try {
      const t = await this.master.call('GetCurrentSceneTransition');
      return { name: t.transitionName, duration_ms: t.transitionDuration || 0 };
    } catch (_) { return null; }
  }

  /** Puts `scene` on the slave unless it's already there. */
  followScene(scene, transition, onlyIfDrifted = false) {
    return this._serial(async () => {
      try {
        this.lastScene = scene;            // the master's scene (shown by the dock)
        const local = await currentProgramScene(this.local);
        if (local === scene) return;
        if (onlyIfDrifted) {
          if (Date.now() - this.lastEventAt < DRIFT_GRACE_MS) return;
          this.log.info(`Slave out of step (${local} instead of ${scene}) - correcting`);
        }
        await switchScene(this.local, scene, transition, this.log);
        this.lastEventAt = Date.now();
        this.error = null;
        const t = transition || {};
        this.log.info(`Following master -> ${scene}  (${t.name} ${t.duration_ms} ms)`);
      } catch (e) {
        // usually: project not synced yet, the scene doesn't exist here
        this.error = `Scene "${scene}" could not be shown here: ${e.message}`;
        this.log.warn(this.error);
      }
    });
  }

  async onEvent(type, data) {
    if (this.paused) return;     // master lost: the slave holds its fallback scene
    if (type === 'CurrentProgramSceneChanged') {
      this.lastEventAt = Date.now();
      await this.followScene(data.sceneName, await this._masterTransition());
    } else if (type === 'MediaInputActionTriggered') {
      if (!MEDIA_ACTIONS.has(data.mediaAction)) return;
      try {
        await this.local.call('TriggerMediaInputAction', { inputName: data.inputName, mediaAction: data.mediaAction });
        this.log.info(`Following master media: ${data.mediaAction.split('_').pop()} on "${data.inputName}"`);
      } catch (e) {
        this.log.warn(`Could not replay ${data.mediaAction} on "${data.inputName}": ${e.message}`);
      }
    }
  }

  async checkDrift() {
    if (this.paused) return;
    let scene;
    try { scene = await currentProgramScene(this.master); } catch (_) { return; }
    // the correction uses the master's transition too: the slave is a mirror
    if (scene) await this.followScene(scene, await this._masterTransition(), true);
  }

  _disconnect() {
    if (this.master) { this.master.removeAllListeners(); this.master.stop(); }
    this.master = null;
    this.key = null;
  }

  async check() {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      if (this.master) this._disconnect();
      this.status = 'disabled'; this.error = null;
      return;
    }
    if (!cfg.master_host) {
      this.status = 'error'; this.error = 'Master address not set';
      return;
    }
    const key = `${cfg.master_host}|${cfg.master_obs_port}|${cfg.master_obs_password}`;
    if (key !== this.key) {
      this._disconnect();
      this.key = key;
      this.master = new ObsClient({
        host: cfg.master_host, port: parseInt(cfg.master_obs_port, 10) || 4455,
        password: cfg.master_obs_password || '', label: 'master OBS',
        events: EVENTS.SCENES | EVENTS.MEDIA_INPUTS,
      });
      this.master.on('event', (t, d) => this.onEvent(t, d));
      this.master.on('connected', () => this.log.info(`Connected to master OBS at ${cfg.master_host}`));
      this.master.on('disconnected', why => this.log.warn(`Lost master OBS (${why}) - retrying`));
      this.master.start();
    }
    if (this.master.connected) {
      this.status = 'connected';
      if (this.error && this.error.startsWith('Master OBS')) this.error = null;
      await this.checkDrift();
    } else {
      this.status = 'connecting';
      this.error = `Master OBS unreachable: ${this.master.lastError || 'connecting...'}`;
    }
  }

  snapshot() {
    return { status: this.status, error: this.error, last_scene: this.lastScene,
             last_event_at: this.lastEventAt || null };
  }
}

class MasterMonitor {
  constructor(getConfig, { autoStart = true } = {}) {
    this.getConfig = getConfig;
    this.data = { reachable: false, error: null, state: null, playlist: null };
    this.rev = null;
    if (autoStart) this._loop();
  }

  async _get(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async _loop() {
    for (;;) {
      const cfg = this.getConfig();
      if (!cfg.enabled || !cfg.master_host) {
        this.data = { reachable: false, error: null, state: null, playlist: null };
        this.rev = null;
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      const base = `http://${cfg.master_host}:${cfg.master_dashboard_port || 8090}`;
      try {
        const state = await this._get(`${base}/api/state`);
        state.fetched_at = Date.now() / 1000;
        // signed requests to the master use its clock (auth.js)
        if (state.server_time) require('./auth').setClockSkew(state.server_time * 1000 - Date.now());
        const rev = `${state.active_playlist}|${state.playlist_rev}`;
        let playlist = this.data.playlist;
        if (rev !== this.rev || !playlist) {
          playlist = await this._get(`${base}/api/playlist`);
          this.rev = rev;
        }
        this.data = { reachable: true, error: null, state, playlist };
      } catch (e) {
        this.data = { ...this.data, reachable: false,
                      error: `Master companion app unreachable (${base}): ${e.message}` };
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  snapshot() { return { ...this.data }; }
}

module.exports = { MasterFollower, MasterMonitor, MEDIA_ACTIONS };
