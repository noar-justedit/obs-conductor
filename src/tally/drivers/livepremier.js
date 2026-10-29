'use strict';
/*
 * Analog Way Aquilon (LivePremier: Aquilon RS alpha / RS1..RS6, C, C+,
 * CMAX): REST API, HTTP port 80, under /api/tpp/v1.
 *
 * Protocol from Analog Way's "LivePremier REST API Programmer's Guide" v4.0
 * and the Bitfocus Companion modules companion-module-analogway-livepremier
 * and companion-module-analogway-awj (MIT).
 *
 * Sent: only GET requests on the read addresses below. Every POST under
 * /api/tpp/v1 acts (take, load-memory, .../source): none is ever sent. When
 * the Web RCS has a password: one POST /auth/login {"password": ...}, which
 * only opens a session (cookie), like logging into the Web RCS.
 *
 *   /system                                      type ("AQL RS2"...), version
 *   /screens/{s}                                 isEnabled, label
 *   /screens/{s}/layers/{l}                      capacity (0: layer not used)
 *   /screens/{s}/layers/{l}/presets/program      {status, sourceType, sourceId}
 *   /screens/{s}/layers/{l}/presets/preview      idem, preview
 *   /auxiliary-screens/{a}(/layers/{l}/presets/{program|preview}/source)
 *   /inputs/{n}                                  label, isEnabled
 * A layer shows input N when sourceType = "input", sourceId = N and its
 * status is not off / close / preempted / out of capacity (to check on a
 * real unit).
 */

const { httpClient, rule, register } = require('../guard');

const P = '\\/api\\/tpp\\/v1';
const RULES = register('livepremier', [
  rule('GET /api/tpp/v1/system', new RegExp(`^GET ${P}\\/system$`)),
  rule('GET /api/tpp/v1/screens/{s}', new RegExp(`^GET ${P}\\/screens\\/\\d{1,2}$`)),
  rule('GET /api/tpp/v1/screens/{s}/layers/{l}', new RegExp(`^GET ${P}\\/screens\\/\\d{1,2}\\/layers\\/\\d{1,3}$`)),
  rule('GET /api/tpp/v1/screens/{s}/layers/{l}/presets/{program|preview}', new RegExp(`^GET ${P}\\/screens\\/\\d{1,2}\\/layers\\/\\d{1,3}\\/presets\\/(program|preview)$`)),
  rule('GET /api/tpp/v1/auxiliary-screens/{a}', new RegExp(`^GET ${P}\\/auxiliary-screens\\/\\d{1,2}$`)),
  rule('GET /api/tpp/v1/auxiliary-screens/{a}/layers/{l}', new RegExp(`^GET ${P}\\/auxiliary-screens\\/\\d{1,2}\\/layers\\/\\d{1,3}$`)),
  rule('GET /api/tpp/v1/auxiliary-screens/{a}/layers/{l}/presets/{program|preview}/source', new RegExp(`^GET ${P}\\/auxiliary-screens\\/\\d{1,2}\\/layers\\/\\d{1,3}\\/presets\\/(program|preview)\\/source$`)),
  rule('GET /api/tpp/v1/inputs/{n}', new RegExp(`^GET ${P}\\/inputs\\/\\d{1,3}$`)),
  rule('POST /auth/login {"password": ...} (session only, when a password is set)', /^POST \/auth\/login \{"password":"(?:[^"\\]|\\.)*"\}$/),
]);
const FORBIDDEN = ['POST /api/tpp/v1/take', 'POST /api/tpp/v1/screens/1/take', 'POST /api/tpp/v1/screens/1/load-memory {"memoryId":1}',
  'POST /api/tpp/v1/screens/1/layers/1/presets/program/source {"sourceType":"input","sourceId":2}',
  'GET /api/tpp/v1/system/reboot', 'POST /api/tpp/v1/system/wakeup', 'GET /api/tpp/v1/screens/1?x=1',
  'POST /auth/login {"password":"a","x":1}'];

const request = httpClient('livepremier');
// the scan: one GET, the system
const SCAN_RULES = register('livepremier-scan', [rule('GET /api/tpp/v1/system', /^GET \/api\/tpp\/v1\/system$/)]);
const scanRequest = httpClient('livepremier-scan');
const HIDDEN = new Set(['off', 'close', 'preempted', 'out of capacity']);
const MAX_SCREENS = 24, MAX_AUX = 96, MAX_LAYERS = 128, MAX_INPUTS = 256;

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.cookie = null; this.layout = null; this.at = 0; this.inputs = []; }

  base() { return `http://${this.cfg.host}${this.cfg.port && this.cfg.port !== 80 ? ':' + this.cfg.port : ''}`; }

  async get(path, quiet404) {
    const once = () => request(this.base() + '/api/tpp/v1' + path, { headers: this.cookie ? { Cookie: this.cookie } : {}, timeout: 2500 });
    let r = await once();
    // a password, or the session expired: log in (one login at a time), once per refusal
    if (r.status === 401 && this.cfg.password) { await this._login(); r = await once(); }
    if (r.status === 401) throw new Error('password needed (Settings: password of the Web RCS)');
    if (r.status === 404 && quiet404) return null;
    if (r.status >= 400) throw new Error(`HTTP ${r.status} on ${path}`);
    try { return JSON.parse(r.body.toString()); } catch (_) { return null; }
  }

  _login() {
    if (!this._logging) this._logging = this._doLogin().finally(() => { this._logging = null; });
    return this._logging;
  }

  async _doLogin() {
    const r = await request(this.base() + '/auth/login', { method: 'POST', body: JSON.stringify({ password: String(this.cfg.password) }),
      headers: { 'Content-Type': 'application/json' } });
    const sc = [].concat(r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    if (r.status >= 400 || !sc) throw new Error('password refused');
    this.cookie = sc;
  }

  // which screens / aux / layers exist: read again every 30 s
  async _layout() {
    const sys = await this.get('/system');
    // identity (2.3.0): an Aquilon / LivePremier (type "AQL..."), or nothing else is read
    if (!sys || !/^AQL|aquilon|livepremier/i.test(String(sys.type || ''))) {
      const e = new Error('this machine doesn\'t say it is an Analog Way Aquilon: nothing else is read'); e.permanent = true; throw e;
    }
    this.model = `Analog Way ${sys.type}`;
    if (!this.layout) this.log.info(`Tally: connected to the ${this.model} at ${this.cfg.host}`);
    const outs = [];
    for (let s = 1; s <= MAX_SCREENS; s++) {
      const sc = await this.get(`/screens/${s}`, true);
      if (!sc) break;
      if (sc.isEnabled === false) continue;
      outs.push({ kind: 'screens', n: s, name: sc.label || `Screen ${s}`, layers: await this._layers('screens', s) });
    }
    for (let a = 1; a <= MAX_AUX; a++) {
      const ax = await this.get(`/auxiliary-screens/${a}`, true);
      if (!ax) break;
      if (ax.isEnabled === false || ax.IsEnabled === false) continue;
      outs.push({ kind: 'auxiliary-screens', n: a, name: ax.label || `Aux ${a}`, layers: await this._layers('auxiliary-screens', a) });
    }
    const ins = [];
    for (let i = 1; i <= MAX_INPUTS; i++) {
      const inp = await this.get(`/inputs/${i}`, true);
      if (!inp) break;
      if (inp.isEnabled === false) continue;
      ins.push({ id: String(i), name: inp.label ? `${inp.label} (IN ${i})` : `Input ${i}` });
    }
    this.layout = outs; this.inputs = ins; this.at = Date.now();
  }

  async _layers(kind, n) {
    const out = [];
    for (let l = 1; l <= MAX_LAYERS; l++) {
      const ly = await this.get(`/${kind}/${n}/layers/${l}`, true);
      if (!ly || ly.capacity === 0) break;
      out.push(l);
    }
    return out;
  }

  async read() {
    if (!this.layout || Date.now() - this.at > 30000) await this._layout();
    const tally = Object.fromEntries(this.inputs.map(i => [i.id, { pgm: [], pvw: [] }]));
    const jobs = [];
    for (const o of this.layout) for (const l of o.layers) for (const which of ['program', 'preview']) {
      const path = `/${o.kind}/${o.n}/layers/${l}/presets/${which}${o.kind === 'auxiliary-screens' ? '/source' : ''}`;
      jobs.push(() => this.get(path, true).then(p => {
        if (!p || p.sourceType !== 'input' || HIDDEN.has(String(p.status || ''))) return;
        const id = String(p.sourceId), t = tally[id] || (tally[id] = { pgm: [], pvw: [] });
        const k = which === 'program' ? 'pgm' : 'pvw';
        if (!t[k].includes(o.name)) t[k].push(o.name);
      }));
    }
    // a few at a time: the unit has other clients
    for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(f => f()));
    return { model: this.model, inputs: this.inputs, tally, screens: this.layout.length };
  }

  close() { this.layout = null; }
}

async function probe(host) {
  const r = await scanRequest(`http://${host}/api/tpp/v1/system`, { timeout: 1500 });
  if (r.status !== 200) return null;
  let j; try { j = JSON.parse(r.body.toString()); } catch (_) { return null; }
  return j && /^AQL/i.test(String(j.type || '')) ? { model: 'Analog Way ' + j.type } : null;
}

module.exports = {
  id: 'livepremier', label: 'Analog Way Aquilon (LivePremier)', vendor: 'Analog Way', port: 80, portHint: 'HTTP 80',
  auth: 'password', authHint: 'Web RCS password, if one is set', scanPorts: [80], pollMs: 1000,
  source: 'companion-module-analogway-livepremier, companion-module-analogway-awj',
  RULES, FORBIDDEN, SCAN_RULES, create: (cfg, log) => new Session(cfg, log), probe,
};
