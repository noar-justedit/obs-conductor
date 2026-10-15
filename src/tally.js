'use strict';
/*
 * Tally from a PixelHue switcher (Q8 / P20 / P80): is this PC's OBS, an
 * input of the switcher, on air (PGM) or in preview (PVW)?
 *
 * No official API: the protocol below was worked out from the Bitfocus
 * Companion module (companion-module-pixelhue-switcher). See docs/Q8-TALLY-API.md.
 *
 *   1. https://<host>:19998/unico/v1/ucenter/device-list?clientType=8
 *      (self-signed certificate) -> the REST port (protocol "http")
 *   2. http://<host>:<port>/unico/v1/node/open-detail -> sn, startTime
 *   3. token = JWT HS256 {"SN": sn}, signed with startTime, sent as the
 *      Authorization header
 *   4. every second: /unico/v1/layers/list-detail and
 *      /unico/v1/screen/list-detail. Each layer says where it is:
 *      layerIdObj.sceneType 2 = PGM, 4 = PVW, on screen
 *      layerIdObj.attachScreenId; source.general.sourceName = the input it
 *      shows (case-sensitive). The input is ON AIR when a PGM layer of a
 *      real output shows it: the multiviewer (screen type 8) doesn't count,
 *      nor a disabled screen or one faded to black (FTB).
 *      (1.5.0 read the presets' currentRegion instead, as the first notes
 *      said: wrong, layers carry no preset id, nothing was ever on air.
 *      Corrected after 1.5.0 from the Companion module's own code.)
 *
 * The switcher's own IDs (sourceId...) are local to each input card: only
 * the input's NAME identifies it.
 *
 * ABSOLUTE RULE (Noar): READ ONLY. This app NEVER sends a command to the
 * switcher (nor to any tally device added later: Aquilon, E2, Encore 3...).
 * Only GET requests, only to the read addresses in READ_ONLY below, never
 * anything on its WebSocket. getJson refuses anything else. See AGENTS.md.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const POLL_MS = 1000;
const RETRY_MS = 3000;

const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function token(sn, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ SN: sn }));
  return `${h}.${p}.${b64url(crypto.createHmac('sha256', String(secret)).update(`${h}.${p}`).digest())}`;
}

// The only addresses this app may call on the switcher: reads, nothing else.
const READ_ONLY = Object.freeze([
  '/unico/v1/ucenter/device-list',    // discovery: its REST port
  '/unico/v1/node/open-detail',       // serial number + start time (token)
  '/unico/v1/layers/list-detail',     // layers: which input, on PGM or PVW, on which screen
  '/unico/v1/screen/list-detail',     // screens: multiviewer, disabled, faded to black
  '/unico/v1/interface/list-detail',  // inputs: their names
]);

function getJson(url, headers = {}, timeout = 3000) {
  return new Promise((resolve, reject) => {
    // read only, always: GET (http.get), and only the addresses above
    let pathname;
    try { pathname = new URL(url).pathname; } catch (_) { return reject(new Error('bad address')); }
    if (!READ_ONLY.includes(pathname)) return reject(new Error(`refused: ${pathname} is not a read address (tally is read only)`));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout, rejectUnauthorized: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) { const e = new Error('refused (token)'); e.auth = true; return reject(e); }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        let j;
        try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { return reject(new Error('not a PixelHue answer')); }
        // the switcher also says "not allowed" inside a 200 answer
        if (j && j.code != null && j.code !== 0 && j.code !== 200 && !j.data) { const e = new Error(j.msg || `error ${j.code}`); e.auth = true; return reject(e); }
        resolve(j);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', reject);
  });
}

const list = j => (j && j.data && (Array.isArray(j.data.list) ? j.data.list : Array.isArray(j.data) ? j.data : [])) || [];

/** Every sourceName found inside an object (the inputs the layers show). */
function sourceNames(obj, out = new Set()) {
  if (Array.isArray(obj)) obj.forEach(o => sourceNames(o, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'sourceName' && typeof v === 'string') out.add(v.trim());
      else if (v && typeof v === 'object') sourceNames(v, out);
    }
  }
  return out;
}

/**
 * 'pgm', 'pvw' or 'none' for this input, from the layers and screens lists.
 * Exported for the tests.
 */
function tallyOf(layers, screens, input) {
  const want = String(input || '').trim();
  const res = { state: 'none', pgm: [], pvw: [], multiviewer: false };
  if (!want) return res;
  const MVR = 8;                                   // multiviewer: shows every input
  const off = new Set(), mvr = new Set(), names = new Map();
  for (const sc of screens || []) {
    const id = String(sc.screenId), type = sc.screenIdObj && parseInt(sc.screenIdObj.type, 10);
    names.set(id, (sc.general && sc.general.name) || `Screen ${sc.screenId}`);
    if (type === MVR) mvr.add(id);
    // screens that show nothing on air: multiviewer, disabled, faded to black
    if (type === MVR || sc.enable === 0 || (sc.ftb && sc.ftb.enable === 1)) off.add(id);
  }
  for (const l of layers || []) {
    const name = l.source && l.source.general && l.source.general.sourceName;
    if (typeof name !== 'string' || name.trim() !== want) continue;
    if (l.enable === 0) continue;                  // a layer switched off shows nothing
    const at = l.layerIdObj || {}, id = String(at.attachScreenId);
    if (parseInt(at.type, 10) === MVR) { res.multiviewer = true; continue; }   // a multiviewer layer, even without the screen list
    if (mvr.has(id)) res.multiviewer = true;
    if (off.has(id)) continue;
    const scene = parseInt(at.sceneType, 10), where = names.get(id) || `Screen ${id}`;
    if (scene === 2 && !res.pgm.includes(where)) res.pgm.push(where);
    else if (scene === 4 && !res.pvw.includes(where)) res.pvw.push(where);
  }
  res.state = res.pgm.length ? 'pgm' : res.pvw.length ? 'pvw' : 'none';
  return res;
}

/** 'pgm', 'pvw' or 'none' for this input. */
const stateOf = (layers, screens, input) => tallyOf(layers, screens, input).state;

class Q8Tally {
  /** getConfig(): {host, input, api_port}. log: the app's log. */
  constructor(getConfig, log) {
    this.getConfig = getConfig;
    this.log = log;
    this.state = { state: null, error: null, preset: null, connected: false };
    this.session = null;            // {host, port, token}
    this._stopped = false;
    this._timer = setTimeout(() => this._loop(), 500);
  }

  stop() { this._stopped = true; clearTimeout(this._timer); }

  snapshot() {
    const c = this.getConfig();
    return { configured: !!(c.host && c.input), host: c.host, input: c.input, ...this.state };
  }

  async _connect(c) {
    let port = c.api_port;
    if (!port) {
      const d = await getJson(`https://${c.host}:19998/unico/v1/ucenter/device-list?clientType=8`);
      const dev = list(d)[0];
      const proto = dev && (dev.protocols || []).find(p => String(p.linkType).toLowerCase() === 'http');
      port = proto ? parseInt(proto.port, 10) : 80;
    }
    const od = await getJson(`http://${c.host}:${port}/unico/v1/node/open-detail`);
    const data = (od && od.data) || {};
    if (!data.sn || data.startTime == null) throw new Error('no serial number from the switcher');
    this.session = { host: c.host, port, sn: String(data.sn), token: token(data.sn, data.startTime) };
    this.log.info(`Tally: connected to the PixelHue at ${c.host}:${port} (SN ${data.sn})`);
  }

  /**
   * The switcher's inputs, by name (Settings > Tally: a list to pick from).
   * From /interface/list-detail (general.name), plus the names its layers
   * show (in case an input appears only there).
   */
  async inputs() {
    const c = this.getConfig();
    if (!c.host) return [];
    if (!this.session || this.session.host !== c.host) await this._connect(c);
    const s = this.session, h = { Authorization: s.token };
    const [ifs, layers, screens] = await Promise.all([
      getJson(`http://${s.host}:${s.port}/unico/v1/interface/list-detail`, h),
      getJson(`http://${s.host}:${s.port}/unico/v1/layers/list-detail`, h).catch(() => null),
      getJson(`http://${s.host}:${s.port}/unico/v1/screen/list-detail`, h).catch(() => null),
    ]);
    const names = new Set();
    for (const i of list(ifs)) {
      const n = (i.general && (i.general.name || i.general.sourceName)) || i.name || i.interfaceName;
      if (typeof n === 'string' && n.trim()) names.add(n.trim());
    }
    for (const n of sourceNames(list(layers))) if (n) names.add(n);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    // where each one is now: helps telling the OBS input from a look-alike
    this.lastStates = Object.fromEntries(sorted.map(n => [n, tallyOf(list(layers), list(screens), n)]));
    return sorted;
  }

  /**
   * Settings > Test connection: a new connection (address, serial number,
   * key), then the inputs and screens read once. Reads only.
   */
  async test() {
    const c = this.getConfig();
    if (!c.host) return { ok: false, error: 'Type the switcher\'s address first' };
    const t0 = Date.now();
    try {
      this.session = null;
      await this._connect(c);
      const s = this.session, h = { Authorization: s.token };
      const [ifs, screens] = await Promise.all([
        getJson(`http://${s.host}:${s.port}/unico/v1/interface/list-detail`, h),
        getJson(`http://${s.host}:${s.port}/unico/v1/screen/list-detail`, h),
      ]);
      return { ok: true, ms: Date.now() - t0, host: s.host, port: s.port, sn: s.sn,
               inputs: list(ifs).length, screens: list(screens).length };
    } catch (e) {
      this.session = null;
      return { ok: false, ms: Date.now() - t0, error: e.message };
    }
  }

  /** What the switcher answers, raw (diagnosis: /api/tally/debug). Reads only. */
  async debug() {
    const c = this.getConfig();
    if (!c.host) return { error: 'no switcher address' };
    if (!this.session || this.session.host !== c.host) await this._connect(c);
    const s = this.session, h = { Authorization: s.token };
    const [layers, screens] = await Promise.all([
      getJson(`http://${s.host}:${s.port}/unico/v1/layers/list-detail`, h),
      getJson(`http://${s.host}:${s.port}/unico/v1/screen/list-detail`, h).catch(e => ({ error: e.message })),
    ]);
    return { input: c.input, tally: tallyOf(list(layers), list(screens), c.input), port: s.port, layers, screens };
  }

  async _poll(c) {
    const s = this.session, h = { Authorization: s.token };
    // both lists are needed: without the screens, a multiviewer or a screen
    // in FTB would look on air (a failed read fails the poll: NO TALLY)
    const [layers, screens] = await Promise.all([
      getJson(`http://${s.host}:${s.port}/unico/v1/layers/list-detail`, h),
      getJson(`http://${s.host}:${s.port}/unico/v1/screen/list-detail`, h),
    ]);
    return tallyOf(list(layers), list(screens), c.input);
  }

  async _loop() {
    if (this._stopped) return;
    let wait = POLL_MS;
    const c = this.getConfig();
    try {
      if (!c.host || !c.input) {
        this.session = null;
        this.state = { state: null, error: null, connected: false };
      } else {
        if (!this.session || this.session.host !== c.host) await this._connect(c);
        const t = await this._poll(c), st = t.state;
        if (st !== this.state.state) this.log.info(`Tally "${c.input}": ${st === 'pgm' ? 'ON AIR on ' + t.pgm.join(', ') : st === 'pvw' ? 'PVW on ' + t.pvw.join(', ') : 'off'}`);
        this.state = { state: st, error: null, connected: true, pgm: t.pgm, pvw: t.pvw, multiviewer: t.multiviewer };
      }
    } catch (e) {
      // token refused (the switcher restarted: new startTime) or switcher
      // away: connect again from scratch
      if (this.state.connected || !this.state.error) this.log.warn(`Tally: ${e.message}`);
      this.session = null;
      this.state = { state: null, error: `PixelHue not reachable: ${e.message}`, connected: false };
      wait = RETRY_MS;
    }
    if (!this._stopped) this._timer = setTimeout(() => this._loop(), wait);
  }
}

/**
 * The input whose name goes with this PC's name ("OBS HALL 8" for the PC
 * HALL8: spaces, dashes and capitals don't count), when exactly one does.
 */
function suggestInput(inputs, pcName) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pc = norm(pcName);
  if (pc.length < 3) return null;
  const hits = inputs.filter(n => { const i = norm(n); return i && (i.includes(pc) || (i.length >= 3 && pc.includes(i))); });
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { Q8Tally, stateOf, tallyOf, token, READ_ONLY, getJson, suggestInput };
