'use strict';
/*
 * NewTek / Vizrt TriCaster (and Viz Vectar, same API): HTTP, port 80.
 *
 * Protocol from the Bitfocus Companion module companion-module-newtek-
 * tricaster (MIT) and other open tally tools (Tally Arbiter, newtek-go).
 *
 * Sent: only these three GET requests, exactly (no other key, no other
 * parameter: /v1/shortcut, /v1/trigger or /v1/datalink?...&value= would act):
 *   /v1/version                          product name and version
 *   /v1/dictionary?key=tally             <column name="input2" on_pgm="true" on_prev="false"/>
 *   /v1/dictionary?key=shortcut_states   input names (input2_long_name = "Cam 2")
 * The TriCaster computes on_pgm itself. A LivePanel password: user and
 * password in Settings (Basic or Digest login, answered when asked).
 */

const { httpClient, rule, register } = require('../guard');

const RULES = register('tricaster', [
  rule('GET /v1/version', /^GET \/v1\/version$/),
  rule('GET /v1/dictionary?key=tally', /^GET \/v1\/dictionary\?key=tally$/),
  rule('GET /v1/dictionary?key=shortcut_states', /^GET \/v1\/dictionary\?key=shortcut_states$/),
]);
const FORBIDDEN = ['GET /v1/shortcut?name=main_background_take', 'GET /v1/trigger?name=x', 'GET /v1/datalink?key=a&value=b',
  'POST /v1/shortcut <shortcuts/>', 'GET /v1/dictionary?key=tally&x=1', 'GET /v1/dictionary?key=switcher'];

const request = httpClient('tricaster');
// the scan: one GET, the version
const SCAN_RULES = register('tricaster-scan', [rule('GET /v1/version', /^GET \/v1\/version$/)]);
const scanRequest = httpClient('tricaster-scan');
const attrs = s => { const o = {}; String(s).replace(/([\w:-]+)="([^"]*)"/g, (_, k, v) => { o[k] = v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); return ''; }); return o; };
// sub-sources of the DDRs / GFX (ddr1_a...): not inputs of their own
const SUB = /^(ddr|gfx)\d+_[ab]$/i;

function parseTally(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<column\s([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.name) out.push({ name: a.name.toLowerCase(), pgm: a.on_pgm === 'true', pvw: a.on_prev === 'true' });
  }
  return out;
}

function parseNames(xml) {
  const n = {};
  for (const m of String(xml).matchAll(/<shortcut_state\s([^>]*?)\/?>/g)) {
    const a = attrs(m[1]), k = /^(.+)_long_name$/.exec(a.name || '');
    if (k && a.value) n[k[1].toLowerCase()] = a.value;
  }
  return n;
}

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.names = {}; this.namesAt = 0; this.model = null; }

  base() { return `http://${this.cfg.host}${this.cfg.port && this.cfg.port !== 80 ? ':' + this.cfg.port : ''}`; }

  async _get(path) {
    const r = await request(this.base() + path, { user: this.cfg.user || (this.cfg.password ? 'admin' : undefined), password: this.cfg.password });
    if (r.status === 401) throw new Error('password refused (Settings: user / password of the LivePanel)');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return r.body.toString('utf8');
  }

  async read() {
    if (!this.model) {
      // identity (2.3.0): the machine must say it is a TriCaster / Vectar before anything else is read
      const v = await this._get('/v1/version');
      const p = /<product_name>([^<]*)</.exec(v), ver = /<product_version>([^<]*)</.exec(v);
      if (!p || !/tricaster|vectar|newtek|vizrt/i.test(p[1])) {
        const e = new Error('this machine doesn\'t say it is a TriCaster: nothing else is read'); e.permanent = true; throw e;
      }
      this.model = `${p[1]}${ver ? ' ' + ver[1] : ''}`;
      this.log.info(`Tally: connected to the ${this.model} at ${this.cfg.host}`);
    }
    const xml = await this._get('/v1/dictionary?key=tally');
    if (!/<tally/.test(xml)) throw new Error('not a TriCaster answer');
    if (Date.now() - this.namesAt > 10000) {
      this.names = parseNames(await this._get('/v1/dictionary?key=shortcut_states').catch(() => '')); this.namesAt = Date.now();
    }
    const cols = parseTally(xml).filter(c => !SUB.test(c.name));
    const order = n => { const m = /^input(\d+)$/.exec(n); return m ? +m[1] : 1000; };
    cols.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
    const inputs = cols.map(c => ({ id: c.name, name: this.names[c.name] ? `${this.names[c.name]} (${c.name})` : c.name }));
    const tally = Object.fromEntries(cols.map(c => [c.name, { pgm: c.pgm ? ['PGM'] : [], pvw: c.pvw ? ['PVW'] : [] }]));
    return { model: this.model, inputs, tally };
  }

  close() { this.model = null; }
}

async function probe(host) {
  const r = await scanRequest(`http://${host}/v1/version`, { timeout: 1500 });
  const s = r.body.toString('utf8'), p = /<product_name>([^<]*)</.exec(s);
  if (p && /tricaster|vectar/i.test(p[1])) return { model: p[1] };
  return r.status === 401 && /tricaster|newtek|vizrt/i.test(String(r.headers['www-authenticate'] || '')) ? { model: 'TriCaster (password)' } : null;
}

module.exports = {
  id: 'tricaster', label: 'TriCaster / Viz Vectar', vendor: 'NewTek / Vizrt', port: 80, portHint: 'HTTP 80',
  auth: 'userpass', authHint: 'LivePanel user / password, if one is set', scanPorts: [80], pollMs: 400,
  source: 'companion-module-newtek-tricaster', RULES, FORBIDDEN, SCAN_RULES, create: (cfg, log) => new Session(cfg, log), probe,
  parseTally, parseNames,
};
