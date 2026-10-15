'use strict';
/*
 * PixelHue Q8, P10, P20, P80 (same "unico" open API on every model).
 *
 * Protocol worked out from the Bitfocus Companion module
 * companion-module-pixelhue-switcher (MIT). See docs/Q8-TALLY-API.md.
 *
 *   1. https://<host>:19998/unico/v1/ucenter/device-list?clientType=8
 *      (self-signed certificate) -> the REST port (protocol "http")
 *   2. http://<host>:<port>/unico/v1/node/open-detail -> sn, startTime
 *   3. token = JWT HS256 {"SN": sn}, signed with startTime, sent as the
 *      Authorization header
 *   4. every second: /unico/v1/layers/list-detail and /unico/v1/screen/
 *      list-detail. Each layer says where it is: layerIdObj.sceneType 2 =
 *      PGM, 4 = PVW, on screen layerIdObj.attachScreenId; source.general.
 *      sourceName = the input it shows (case-sensitive). The input is ON AIR
 *      when a PGM layer of a real output shows it: the multiviewer (screen
 *      type 8) doesn't count, nor a disabled screen or one faded to black.
 *
 * The switcher's own IDs are local to each input card: only the input's NAME
 * identifies it (the input's id here IS its name).
 *
 * READ ONLY: only GET, only the five addresses below.
 */

const crypto = require('crypto');
const { httpClient, rule, register } = require('../guard');

const READ_ONLY = Object.freeze([
  '/unico/v1/ucenter/device-list',    // discovery: its REST port
  '/unico/v1/node/open-detail',       // serial number + start time (token)
  '/unico/v1/layers/list-detail',     // layers: which input, on PGM or PVW, on which screen
  '/unico/v1/screen/list-detail',     // screens: multiviewer, disabled, faded to black
  '/unico/v1/interface/list-detail',  // inputs: their names
]);
const RULES = register('pixelhue', [
  rule('GET /unico/v1/ucenter/device-list[?clientType=8]', /^GET \/unico\/v1\/ucenter\/device-list(\?clientType=8)?$/),
  rule('GET /unico/v1/node/open-detail', /^GET \/unico\/v1\/node\/open-detail$/),
  rule('GET /unico/v1/layers/list-detail', /^GET \/unico\/v1\/layers\/list-detail$/),
  rule('GET /unico/v1/screen/list-detail', /^GET \/unico\/v1\/screen\/list-detail$/),
  rule('GET /unico/v1/interface/list-detail', /^GET \/unico\/v1\/interface\/list-detail$/),
]);
const FORBIDDEN = ['PUT /unico/v1/screen/take', 'GET /unico/v1/preset/apply', 'POST /unico/v1/layers/source',
  'GET /unico/v1/screen/ftb', 'GET /', 'GET /unico/v1/layers/list-detail?x=1'];

const request = httpClient('pixelhue');
// the scan: one GET, the device list
const SCAN_RULES = register('pixelhue-scan', [rule('GET /unico/v1/ucenter/device-list?clientType=8', /^GET \/unico\/v1\/ucenter\/device-list\?clientType=8$/)]);
const scanRequest = httpClient('pixelhue-scan');

const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function token(sn, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ SN: sn }));
  return `${h}.${p}.${b64url(crypto.createHmac('sha256', String(secret)).update(`${h}.${p}`).digest())}`;
}

async function getJson(url, headers = {}, timeout = 3000) {
  const r = await request(url, { headers, timeout });
  if (r.status === 401 || r.status === 403) { const e = new Error('refused (token)'); e.auth = true; throw e; }
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  let j;
  try { j = JSON.parse(r.body.toString()); } catch (e) { throw new Error('not a PixelHue answer'); }
  // the switcher also says "not allowed" inside a 200 answer
  if (j && j.code != null && j.code !== 0 && j.code !== 200 && !j.data) { const e = new Error(j.msg || `error ${j.code}`); e.auth = true; throw e; }
  return j;
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

/** {state, pgm:[screens], pvw:[screens], multiviewer} for this input. */
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
    if (parseInt(at.type, 10) === MVR) { res.multiviewer = true; continue; }
    if (mvr.has(id)) res.multiviewer = true;
    if (off.has(id)) continue;
    const scene = parseInt(at.sceneType, 10), where = names.get(id) || `Screen ${id}`;
    if (scene === 2 && !res.pgm.includes(where)) res.pgm.push(where);
    else if (scene === 4 && !res.pvw.includes(where)) res.pvw.push(where);
  }
  res.state = res.pgm.length ? 'pgm' : res.pvw.length ? 'pvw' : 'none';
  return res;
}

const stateOf = (layers, screens, input) => tallyOf(layers, screens, input).state;

const MODELS = { 28944: 'P20', 28945: 'P10', 29974: 'Q8', 30006: 'P80' };

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.s = null; this.names = []; this.namesAt = 0; }

  async _connect() {
    const c = this.cfg;
    let port = c.port || c.api_port, model = 'PixelHue';
    if (!port) {
      const d = await getJson(`https://${c.host}:19998/unico/v1/ucenter/device-list?clientType=8`);
      const dev = list(d)[0];
      const proto = dev && (dev.protocols || []).find(p => String(p.linkType).toLowerCase() === 'http');
      port = proto ? parseInt(proto.port, 10) : 80;
      if (dev && MODELS[dev.modelId]) model = 'PixelHue ' + MODELS[dev.modelId];
    }
    const od = await getJson(`http://${c.host}:${port}/unico/v1/node/open-detail`);
    const data = (od && od.data) || {};
    if (!data.sn || data.startTime == null) throw new Error('no serial number from the switcher');
    this.s = { host: c.host, port, sn: String(data.sn), token: token(data.sn, data.startTime), model };
    this.log.info(`Tally: connected to the PixelHue at ${c.host}:${port} (SN ${data.sn})`);
  }

  async _lists(withNames) {
    if (!this.s) await this._connect();
    const s = this.s, h = { Authorization: s.token }, base = `http://${s.host}:${s.port}/unico/v1`;
    try {
      // both lists are needed: without the screens, a multiviewer or a screen
      // in FTB would look on air (a failed read fails the poll: NO TALLY)
      const [layers, screens, ifs] = await Promise.all([
        getJson(`${base}/layers/list-detail`, h), getJson(`${base}/screen/list-detail`, h),
        withNames ? getJson(`${base}/interface/list-detail`, h) : null]);
      return { layers: list(layers), screens: list(screens), ifs: ifs ? list(ifs) : null };
    } catch (e) {
      // token refused (the switcher restarted: new startTime): connect again
      this.s = null;
      throw e;
    }
  }

  async read() {
    const fresh = Date.now() - this.namesAt > 10000;
    const { layers, screens, ifs } = await this._lists(fresh);
    if (ifs) {
      const names = new Set();
      for (const i of ifs) {
        const n = (i.general && (i.general.name || i.general.sourceName)) || i.name || i.interfaceName;
        if (typeof n === 'string' && n.trim()) names.add(n.trim());
      }
      this.names = [...names]; this.namesAt = Date.now();
    }
    const all = new Set(this.names);
    for (const n of sourceNames(layers)) if (n) all.add(n);
    const inputs = [...all].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(n => ({ id: n, name: n }));
    const tally = {};
    for (const i of inputs) { const t = tallyOf(layers, screens, i.id); tally[i.id] = { pgm: t.pgm, pvw: t.pvw, multiviewer: t.multiviewer }; }
    return { model: this.s ? this.s.model : 'PixelHue', detail: this.s ? `SN ${this.s.sn}, port ${this.s.port}` : '',
             screens: screens.length, inputs, tally };
  }

  async debug() {
    const { layers, screens } = await this._lists(false);
    return { port: this.s && this.s.port, layers, screens };
  }

  close() { this.s = null; }
}

/** Scan: is a PixelHue at this address? (one read) */
async function probe(host) {
  const r = await scanRequest(`https://${host}:19998/unico/v1/ucenter/device-list?clientType=8`, { timeout: 1500 });
  let d; try { d = JSON.parse(r.body.toString()); } catch (_) { return null; }
  const dev = list(d)[0];
  if (!dev) return null;
  return { model: 'PixelHue ' + (MODELS[dev.modelId] || dev.deviceName || '') };
}

module.exports = {
  id: 'pixelhue', label: 'PixelHue Q8 / P10 / P20 / P80', vendor: 'PixelHue',
  port: null, portHint: 'found by itself', auth: null, scanPorts: [19998],
  source: 'companion-module-pixelhue-switcher',
  RULES, FORBIDDEN, SCAN_RULES, create: (cfg, log) => new Session(cfg, log), probe,
  // tests and older callers
  token, tallyOf, stateOf, getJson, READ_ONLY,
};
