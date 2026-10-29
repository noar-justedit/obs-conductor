'use strict';
/*
 * OBS connection (obs-websocket protocol v5, built into OBS 28+) and the
 * few OBS helpers the app needs.
 *
 * ObsClient keeps itself connected: if OBS is closed, crashes or restarts,
 * it reconnects in the background (every 3 s, then backing off to 30 s).
 * While OBS is away, requests fail at once with ObsUnavailable instead of
 * hanging. Uses Node's built-in WebSocket: no extra dependency.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const REQUEST_TIMEOUT_MS = 5000;

// Event categories (obs-websocket "EventSubscription" bits)
const EVENTS = { NONE: 0, SCENES: 1 << 2, TRANSITIONS: 1 << 4, MEDIA_INPUTS: 1 << 8 };

const { fileDuration, inputFile } = require('./media-duration');

const MEDIA_SOURCE_KINDS = new Set(['ffmpeg_source', 'vlc_source']);

class ObsUnavailable extends Error {}
class ObsRequestError extends Error {
  constructor(type, status) {
    super(`${type}: ${status.comment || 'refused by OBS'} (code ${status.code})`);
    this.code = status.code;
  }
}

const sha256b64 = s => crypto.createHash('sha256').update(s).digest('base64');

class ObsClient extends EventEmitter {
  /** @param {{host, port, password, events?, label?}} cfg */
  constructor(cfg) {
    super();
    this.cfg = { host: 'localhost', port: 4455, password: '', events: EVENTS.NONE, label: 'OBS', ...cfg };
    this.connected = false;
    this.lastError = null;
    this._ws = null;
    this._pending = new Map();
    this._delay = RECONNECT_MIN_MS;
    this._timer = null;
    this._stopped = true;
  }

  start() {
    if (!this._stopped) return this;
    this._stopped = false;
    this._connect();
    return this;
  }

  /** Try now instead of waiting for the next retry (up to 30 s away), e.g.
   *  right after the WebSocket server was switched on in OBS. */
  reconnectNow() {
    if (this._stopped || this.connected || this._ws) return;
    clearTimeout(this._timer);
    this._delay = RECONNECT_MIN_MS;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    if (this._ws) try { this._ws.close(); } catch (_) {}
    this._drop('closed by the app');
  }

  _connect() {
    if (this._stopped) return;
    // lets the app pick up OBS's own port / password before each attempt
    if (this.cfg.beforeConnect) try { this.cfg.beforeConnect(this.cfg); } catch (_) {}
    const { host, port } = this.cfg;
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${port}`, 'obswebsocket.json');
    } catch (e) {
      this.lastError = e.message;
      return this._scheduleReconnect();
    }
    this._ws = ws;
    ws.onmessage = ev => this._onMessage(ev.data);
    // Node's own message here is unhelpful ("non-101 status code"): say what it means
    const down = ev => {
      if (this._ws !== ws) return;
      this._ws = null;
      const was = this.connected;
      if (ev && ev.code === 4009) this.lastError = 'wrong OBS websocket password';
      else if (ev && ev.reason) this.lastError = ev.reason;
      this._drop(this.lastError || 'connection closed');
      if (was) this.emit('disconnected', this.lastError);
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      if (this._ws !== ws) return;     // this socket is already given up
      this.lastError = `cannot reach ${host}:${port} - is OBS running, with Tools > WebSocket Server Settings enabled?`;
      // Node 22: a refused connection fires "error" and no "close" (it stays
      // CONNECTING): without this the app would never try again. Given up
      // first, closed after: close() fires "error" again.
      if (ws.readyState !== WebSocket.OPEN) { down({}); try { ws.close(); } catch (_) {} }
    };
    ws.onclose = down;
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), this._delay);
    this._delay = Math.min(this._delay * 2, RECONNECT_MAX_MS);
  }

  _drop(reason) {
    this.connected = false;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new ObsUnavailable(reason));
    }
    this._pending.clear();
  }

  _send(op, d) { this._ws.send(JSON.stringify({ op, d })); }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    // anything can answer on that port (a fake or broken OBS): a malformed
    // message is ignored, it never stops the app (review 2.2.2)
    if (!msg || typeof msg !== 'object') return;
    try { this._handle(msg.op, msg.d || {}); }
    catch (e) {
      if (!this.connected) this.lastError = `${this.cfg.label}: unexpected message (${e.message})`;
      console.error(`${this.cfg.label}: message ignored: ${e.stack || e.message}`);
    }
  }

  _handle(op, d) {
    if (op === 0) {                       // Hello
      const ident = { rpcVersion: 1, eventSubscriptions: this.cfg.events };
      if (d.authentication) {
        const secret = sha256b64((this.cfg.password || '') + d.authentication.salt);
        ident.authentication = sha256b64(secret + d.authentication.challenge);
      }
      this._send(1, ident);
    } else if (op === 2) {                // Identified
      this.connected = true;
      this.lastError = null;
      this._delay = RECONNECT_MIN_MS;
      this.emit('connected');
    } else if (op === 5) {                // Event
      this.emit('event', d.eventType, d.eventData || {});
    } else if (op === 7) {                // RequestResponse
      const p = d.requestId != null ? this._pending.get(d.requestId) : null;
      if (!p) return;
      this._pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new ObsRequestError(d.requestType, d.requestStatus || {}));
    }
  }

  /** Sends one request, resolves with OBS's responseData. */
  call(requestType, requestData) {
    if (!this.connected || !this._ws) {
      return Promise.reject(new ObsUnavailable(this.lastError || `${this.cfg.label} not connected`));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new ObsUnavailable(`${requestType}: no answer from ${this.cfg.label}`));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(requestId, { resolve, reject, timer });
      try {
        this._send(6, { requestType, requestId, requestData: requestData || {} });
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        reject(new ObsUnavailable(e.message));
      }
    });
  }
}

// ============================================================
// Helpers
// ============================================================

/** Scene names, in the order of OBS's Scenes dock (top first). */
async function listScenes(c) {
  const r = await c.call('GetSceneList');
  // obs-websocket lists scenes bottom-up: reverse to match OBS's dock
  return (r.scenes || []).slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map(s => s.sceneName);
}

async function currentProgramScene(c) {
  const r = await c.call('GetCurrentProgramScene');
  return r.currentProgramSceneName || r.sceneName || null;
}

const isContainer = it => !!it.isGroup || it.sourceType === 'OBS_SOURCE_TYPE_SCENE';

/**
 * Video sources (Media Source, VLC) of a scene, including inside nested
 * scenes and groups: [{source, duration (s) | null, hidden, loop}].
 * - hidden: the source (or the nested scene / group holding it) has its eye
 *   off. Listed anyway: a macro or an operator may show it on air.
 * - loop: the source loops ("Loop" ticked). A loop has no end: it never gives
 *   the cue its duration by itself (a 60 s background loop in every scene
 *   would otherwise make every cue 60 s).
 * When OBS gives no length (file not loaded: "Close file when inactive", VLC
 * source never played; some ProRes .mov), it is read in the file itself for
 * .mov / .mp4 (media-duration.js). Still null for other containers, live
 * streams and VLC playlists of several files.
 */
async function sceneMedia(c, sceneName, seen = new Set(), isGroup = false, hiddenAbove = false) {
  if (seen.has(sceneName)) return [];
  seen.add(sceneName);
  let items;
  try {
    const r = await c.call(isGroup ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName });
    items = r.sceneItems || [];
  } catch (e) {
    if (e instanceof ObsUnavailable) throw e;
    return [];
  }
  const found = [];
  for (const it of items) {
    const hidden = hiddenAbove || it.sceneItemEnabled === false;
    if (MEDIA_SOURCE_KINDS.has(it.inputKind)) {
      let duration = null, settings = {};
      try {
        const st = await c.call('GetMediaInputStatus', { inputName: it.sourceName });
        if (st.mediaDuration && st.mediaDuration > 0) duration = st.mediaDuration / 1000;
      } catch (e) {
        if (e instanceof ObsUnavailable) throw e;
      }
      try {
        settings = (await c.call('GetInputSettings', { inputName: it.sourceName })).inputSettings || {};
      } catch (e) {
        if (e instanceof ObsUnavailable) throw e;
      }
      // OBS has none: read it in the file (see media-duration.js)
      if (!duration) duration = fileDuration(inputFile(it.inputKind, settings)) || null;
      const loop = it.inputKind === 'vlc_source' ? !!settings.loop : !!settings.looping;
      if (!found.some(f => f.source === it.sourceName)) found.push({ source: it.sourceName, duration, hidden, loop });
    } else if (isContainer(it)) {
      for (const m of await sceneMedia(c, it.sourceName, seen, !!it.isGroup, hidden)) {
        if (!found.some(f => f.source === m.source)) found.push(m);
      }
    }
  }
  return found;
}

/** The video that gives a cue its duration: the LONGEST one that is shown
 *  and doesn't loop (a clip over a background loop lasts as long as the
 *  clip). null when there is none: the cue keeps the default duration. */
function referenceVideo(media) {
  const ok = (media || []).filter(m => m.duration && !m.hidden && !m.loop);
  return ok.length ? ok.reduce((a, b) => (b.duration > a.duration ? b : a)) : null;
}

async function sceneDuration(c, sceneName) {
  const r = referenceVideo(await sceneMedia(c, sceneName));
  return r ? r.duration : 0;
}

async function listTransitions(c) {
  const r = await c.call('GetSceneTransitionList');
  const list = r.transitions || [];
  return {
    names: list.map(t => t.transitionName),
    fixed: list.filter(t => t.transitionFixed).map(t => t.transitionName),
    current: r.currentSceneTransitionName || null,
  };
}

/**
 * Selects the transition (and its length), then puts the scene on program.
 * This changes OBS's current transition (the one in OBS's own Scene
 * Transitions dock). A Transition Override set on the scene in OBS
 * (right-click > Transition Override) wins over this one.
 */
async function switchScene(c, sceneName, transition, log) {
  if (transition && transition.name) {
    try {
      await c.call('SetCurrentSceneTransition', { transitionName: transition.name });
      const ms = parseInt(transition.duration_ms, 10) || 0;
      if (ms >= 50) {   // OBS accepts 50 ms - 20 s; fixed transitions (Cut, Stinger) refuse it
        await c.call('SetCurrentSceneTransitionDuration', { transitionDuration: Math.min(ms, 20000) })
          .catch(e => { if (e instanceof ObsUnavailable) throw e; });
      }
    } catch (e) {
      if (e instanceof ObsUnavailable) throw e;
      if (log) log.warn(`Transition '${transition.name}' unavailable in OBS (${e.message}) - using the current one`);
    }
  }
  await c.call('SetCurrentProgramScene', { sceneName });
}

/** Rewinds every video of a scene ("restart_media_on_switch" option). */
async function restartMediaInScene(c, sceneName, seen = new Set(), isGroup = false) {
  if (seen.has(sceneName)) return;
  seen.add(sceneName);
  let items = [];
  try {
    items = (await c.call(isGroup ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName })).sceneItems || [];
  } catch (_) { return; }
  for (const it of items) {
    if (MEDIA_SOURCE_KINDS.has(it.inputKind)) {
      await c.call('TriggerMediaInputAction', {
        inputName: it.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      }).catch(() => {});
    } else if (isContainer(it)) {
      await restartMediaInScene(c, it.sourceName, seen, !!it.isGroup);
    }
  }
}

module.exports = {
  ObsClient, ObsUnavailable, ObsRequestError, EVENTS, MEDIA_SOURCE_KINDS,
  listScenes, currentProgramScene, sceneMedia, referenceVideo, sceneDuration, listTransitions,
  switchScene, restartMediaInScene,
};
