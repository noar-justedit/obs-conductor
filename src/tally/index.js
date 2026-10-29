'use strict';
/*
 * TALLY: is this PC's OBS, an input of the switcher, on air (PGM) or in
 * preview (PVW)?
 *
 *   machine protocol  ->  driver (translation)  ->  this engine  ->  dock
 *
 * The engine (this file) is OBS Conductor's own: it knows nothing about any
 * machine. Each machine has a driver in drivers/ that TRANSLATES its
 * protocol into one common picture, the same for all:
 *
 *   { model: 'ATEM Mini Pro',
 *     inputs: [{ id: '3', name: 'Cam 3' }, ...],
 *     tally:  { '3': { pgm: ['PGM'], pvw: [] }, ... } }   // where it is on air / in preview
 *
 * The engine picks the input chosen in Settings out of it. Adding a machine
 * = one driver file + its line in DRIVERS (docs/TALLY-DEVICES.md).
 *
 * ABSOLUTE RULE (Noar): READ ONLY. No driver ever sends a command to a
 * switcher; every message goes through guard.js, checked against the
 * driver's closed list of read messages. See guard.js and AGENTS.md.
 */

const { candidateHosts } = require('../discovery');
const guard = require('./guard');

const DRIVERS = [
  require('./drivers/atem'),
  require('./drivers/roland'),
  require('./drivers/vmix'),
  require('./drivers/tricaster'),
  require('./drivers/eventmaster'),
  require('./drivers/livepremier'),
  require('./drivers/livecore'),
  require('./drivers/pixelhue'),
  require('./drivers/kairos'),
];
const BY_ID = Object.fromEntries(DRIVERS.map(d => [d.id, d]));

const RETRY_MS = 3000;

/**
 * The output a tally entry belongs to (2.3.0, Settings > Tally > outputs):
 * "Mix 2 preview" -> "Mix 2", "PGM (layer)" -> "PGM", the preview of the main
 * program ("PVW", "PST", "Preview") -> the main program. An output unticked
 * in Settings doesn't count: neither its on air nor its preview.
 */
function outputOf(where) {
  const s = String(where).replace(/ \((layer|background)\)$/, '').replace(/ preview$/, '');
  return ({ PVW: 'PGM', PST: 'PGM', Preview: 'On air' })[s] || s;
}
const countsOnly = (t, excluded) => {
  if (!excluded || !excluded.length) return t;
  const ex = new Set(excluded), keep = l => (l || []).filter(w => !ex.has(outputOf(w)));
  return { ...t, pgm: keep(t.pgm), pvw: keep(t.pvw) };
};

/** What the dock shows in the machine list. */
const catalog = () => DRIVERS.map(d => ({ id: d.id, label: d.label, vendor: d.vendor, port: d.port, port_hint: d.portHint,
  scanned: !!d.probe, scan_hint: d.scanHint || '',
  auth: d.auth || null, auth_hint: d.authHint || '', default_user: d.defaultUser || '' }));

class TallyEngine {
  /** getConfig(): {device, host, port, user, password, input, input_name}. */
  constructor(getConfig, log) {
    this.getConfig = getConfig;
    this.log = log;
    this.state = { state: null, error: null, connected: false };
    this.sess = null; this.key = null; this.last = null;   // last = {sess, res}
    this.blocked = null;                                     // {key, error}: no retry until the config changes
    this._stopped = false;
    this._gen = 0;   // one polling chain only: a STOP TALLY during a read doesn't start a second one
    this._timer = setTimeout(() => this._loop(this._gen), 500);
  }

  stop() { this._stopped = true; clearTimeout(this._timer); this._close(); }

  driver(c = this.getConfig()) { return BY_ID[c.device] || null; }

  _close() { if (this.sess) try { this.sess.close(); } catch (_) {} this.sess = null; this.key = null; this.last = null; }

  _keyOf(c) { return JSON.stringify([c.device, c.host, c.port, c.api_port, c.user, c.password]); }

  /** The driver's session for this config (a new one when the config changes). */
  _session(c) {
    const d = this.driver(c);
    if (!d) throw new Error('choose the switcher model');
    const key = this._keyOf(c);
    if (this.sess && this.key === key) return this.sess;
    this._close();
    this.sess = d.create({ host: c.host, port: c.port || null, api_port: c.api_port || null, user: c.user || '', password: c.password || '' }, this.log);
    this.key = key;
    return this.sess;
  }

  /**
   * One read of the session, shared: the polling loop, Settings' list, the
   * test and the debug page never read the same machine twice at once. A
   * failed read closes THAT session only (not one made since).
   */
  _read(s) {
    if (s._tallyRead) return s._tallyRead;
    s._tallyRead = s.read().then(res => {
      if (this.sess === s) this.last = { sess: s, res };
      return res;
    }, e => {
      if (this.sess === s) this._close();
      throw e;
    }).finally(() => { s._tallyRead = null; });
    return s._tallyRead;
  }

  _lastOf(s) { return this.last && this.last.sess === s ? this.last.res : null; }

  snapshot() {
    const c = this.getConfig(), d = this.driver(c), last = this.sess ? this._lastOf(this.sess) : null;
    const name = c.input_name || (last && (last.inputs.find(i => i.id === c.input) || {}).name) || c.input;
    return { configured: !!(d && c.host && c.input), device: c.device || '', device_label: d ? d.label : '',
             host: c.host, input: name, input_id: c.input, model: last ? last.model : null, ...this.state,
             cut: guard.isCut() };
  }

  /**
   * STOP TALLY: cut (true) or turn on (false) the whole tally. Cut: guard.js
   * closes every connection and lets nothing out; the state is "no tally".
   */
  setCut(on) {
    guard.setCut(on);
    this._close();
    this.blocked = null;
    this.state = { state: null, error: null, connected: false };
    this.log.info(on ? 'Tally STOPPED (Stop tally): nothing is sent to any switcher' : 'Tally turned on');
    clearTimeout(this._timer);
    const gen = ++this._gen;
    if (!this._stopped) this._timer = setTimeout(() => this._loop(gen), on ? 1000 : 50);
    return guard.isCut();
  }

  async _loop(gen) {
    if (this._stopped || gen !== this._gen) return;
    const c = this.getConfig(), d = this.driver(c);
    let wait = (d && d.pollMs) || 1000;
    try {
      if (guard.isCut()) {
        // STOP TALLY: nothing is read, nothing is sent
        this._close();
        this.state = { state: null, error: null, connected: false };
      } else if (!d || !c.host || !c.input) {
        if (!d || !c.host) this._close();
        this.state = { state: null, error: null, connected: false };
      } else if (this.blocked && this.blocked.key === this._keyOf(c)) {
        // a permanent refusal (unsupported model...): wait for a new config
        this.state = { state: null, error: this.blocked.error, connected: false };
      } else {
        this.blocked = null;
        const res = await this._read(this._session(c));
        const t = countsOnly((res.tally && res.tally[c.input]) || { pgm: [], pvw: [] }, c.exclude_outputs);
        const st = t.pgm.length ? 'pgm' : t.pvw.length ? 'pvw' : 'none';
        if (st !== this.state.state) this.log.info(`Tally "${c.input_name || c.input}": ${st === 'pgm' ? 'ON AIR on ' + t.pgm.join(', ') : st === 'pvw' ? 'PVW on ' + t.pvw.join(', ') : 'off'}`);
        this.state = { state: st, error: null, connected: true, pgm: t.pgm, pvw: t.pvw, multiviewer: !!t.multiviewer };
      }
    } catch (e) {
      // stopped meanwhile (STOP TALLY): not an error of the switcher
      if (gen !== this._gen || e instanceof guard.Cut || guard.isCut()) { if (!this._stopped && gen === this._gen) this._timer = setTimeout(() => this._loop(gen), 1000); return; }
      if (this.state.connected || !this.state.error) this.log.warn(`Tally: ${e.message}`);
      const error = `${d ? d.label : 'Switcher'} not reachable: ${e.message}`;
      if (e.permanent) this.blocked = { key: this._keyOf(c), error: `${d ? d.label : 'Switcher'}: ${e.message}` };
      this.state = { state: null, error: e.permanent ? this.blocked.error : error, connected: false };
      wait = RETRY_MS;
    }
    if (!this._stopped && gen === this._gen) this._timer = setTimeout(() => this._loop(gen), wait);
  }

  /** Settings: the machine's inputs [{id, name}], and where each one is now. */
  async inputs() {
    if (guard.isCut()) throw new guard.Cut();
    const c = this.getConfig();
    if (!this.driver(c) || !c.host) return { inputs: [], states: {} };
    // a model refused for good (Roland V-60HD...): not asked again until the settings change
    if (this.blocked && this.blocked.key === this._keyOf(c)) throw new Error(this.blocked.error);
    const s = this._session(c);
    const res = this._lastOf(s) || await this._read(s);
    // the outputs seen on the machine (and the ones unticked, so they can be ticked again)
    const outs = new Set(c.exclude_outputs || []);
    for (const t of Object.values(res.tally || {})) for (const w of [...(t.pgm || []), ...(t.pvw || [])]) outs.add(outputOf(w));
    return { inputs: res.inputs, states: res.tally || {}, model: res.model,
             outputs: [...outs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), excluded: c.exclude_outputs || [] };
  }

  /** Settings > Test connection: a new connection, one full read. Reads only. */
  async test() {
    if (guard.isCut()) return { ok: false, error: 'The tally is stopped: turn it on first' };
    const c = this.getConfig(), d = this.driver(c);
    if (!d) return { ok: false, error: 'Choose the switcher model first' };
    if (!c.host) return { ok: false, error: 'Type the switcher\'s address first' };
    const t0 = Date.now();
    this._close();
    this.blocked = null;
    try {
      const res = await this._read(this._session(c));
      return { ok: true, ms: Date.now() - t0, model: res.model, detail: res.detail || '', inputs: res.inputs.length,
               screens: res.screens != null ? res.screens : null };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message };
    }
  }

  /** What the machine answers (diagnosis: /api/tally/debug). Reads only. */
  async debug() {
    if (guard.isCut()) throw new guard.Cut();
    const c = this.getConfig();
    // no address: nothing is read (an empty address would mean this PC itself)
    if (!c.host) throw new Error('type the switcher\'s address first');
    const s = this._session(c);
    const res = await this._read(s);
    return { device: c.device, input: c.input, tally: res.tally[c.input] || null, model: res.model,
             raw: s.debug ? await s.debug() : null, inputs: res.inputs };
  }
}

/**
 * Settings > Scan: the switchers on this PC's network (each /24). On demand
 * only. Nothing is sent to a machine that isn't known yet but a TCP
 * connection and, for some models, ONE GET request (Noar's choice, 2.2.1):
 *   - vMix, Roland, LiveCore greet by themselves: nothing is sent;
 *   - TriCaster, Aquilon, PixelHue, KAIROS: one GET (their "*-scan" list);
 *   - ATEM (a hello opens a session) and Barco (POST requests): not scanned,
 *     chosen in the list.
 */
async function scan({ hosts, timeout = 600 } = {}) {
  if (guard.isCut()) throw new guard.Cut();
  hosts = hosts || candidateHosts().hosts;
  const found = [];
  const add = (d, host, r) => found.push({ host, device: d.id, label: d.label, model: (r && r.model) || d.label, needs_auth: !!(r && r.needsAuth) });
  const tcpDrivers = DRIVERS.filter(d => d.scanPorts && d.scanPorts.length && d.probe);
  const queue = hosts.slice();
  const worker = async () => {
    for (let h; (h = queue.shift());) {
      const open = new Map();
      await Promise.all([...new Set(tcpDrivers.flatMap(d => d.scanPorts))].map(async p => open.set(p, await guard.tcpOpen(h, p, timeout))));
      for (const d of tcpDrivers) {
        if (guard.isCut()) return;
        if (!d.scanPorts.some(p => open.get(p))) continue;
        const r = await d.probe(h).catch(() => null);
        if (r) add(d, h, r);
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

/** Simulation (--simulate): a fake network with two switchers. */
const FAKE_SCAN = [
  { host: '192.168.1.40', device: 'vmix', label: 'vMix', model: 'vMix 27.0.0.49', needs_auth: false },
  { host: '192.168.1.60', device: 'livepremier', label: 'Analog Way Aquilon (LivePremier)', model: 'Analog Way AQL RS2', needs_auth: false },
];

/**
 * The input whose name goes with this PC's name ("OBS HALL 8" for the PC
 * HALL8: spaces, dashes and capitals don't count), when exactly one does.
 * inputs: names, or [{id, name}] (then the id is returned).
 */
function suggestInput(inputs, pcName) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pc = norm(pcName);
  if (pc.length < 3) return null;
  const hits = inputs.filter(x => { const i = norm(typeof x === 'string' ? x : x.name); return i && (i.includes(pc) || (i.length >= 3 && pc.includes(i))); });
  if (hits.length !== 1) return null;
  return typeof hits[0] === 'string' ? hits[0] : hits[0].id;
}

const pixelhue = BY_ID.pixelhue;
module.exports = {
  TallyEngine, DRIVERS, BY_ID, catalog, scan, FAKE_SCAN, suggestInput, outputOf, countsOnly,
  // PixelHue helpers, as before (tests)
  stateOf: pixelhue.stateOf, tallyOf: pixelhue.tallyOf, token: pixelhue.token, READ_ONLY: pixelhue.READ_ONLY, getJson: pixelhue.getJson,
};
