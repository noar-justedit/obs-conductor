'use strict';
/*
 * vMix: its TCP API, port 8099 (always on, no password).
 *
 * Protocol from the Bitfocus Companion module companion-module-studiocoast-
 * vmix (MIT) and vMix's TCP API documentation.
 *
 * Sent: only the line "XML" (a read: vMix answers "XML <bytes>" then its
 * whole state as XML). Never "FUNCTION ..." (that one runs actions).
 *
 * Read from the XML (what Companion's tally uses):
 *   <inputs><input key="GUID" number="3" title="Cam 1">   the inputs
 *   <active>3</active> / <preview>2</preview>              Mix 1 PGM / PVW
 *   <overlays><overlay number="1">5</overlay>              input 5 on air in
 *     overlay 1; preview="True": the overlay is in preview
 * An input is identified by its key (its number changes when inputs move).
 * Mix 2..16 (other outputs) are not counted as on air.
 */

const { GuardedSocket, rule, register } = require('../guard');

const PORT = 8099;
const RULES = register('vmix', [rule('XML (read the state)', /^XML\r\n$/)]);
// the scan: nothing at all is sent (vMix greets by itself)
const SCAN_RULES = register('vmix-scan', []);
const FORBIDDEN = ['FUNCTION Cut\r\n', 'FUNCTION PreviewInput Input=5\r\n', 'XML\r\nFUNCTION Cut\r\n', 'XMLTEXT x\r\n', 'xml\r\n'];

const unesc = s => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attrs = s => { const o = {}; String(s).replace(/([\w:-]+)="([^"]*)"/g, (_, k, v) => { o[k] = unesc(v); return ''; }); return o; };

/** {version, edition, inputs:[{key, number, title}], active, preview, overlays:[{number, input, preview}]} */
function parseXml(xml) {
  const r = { inputs: [], overlays: [] };
  const v = /<version>([^<]*)<\/version>/.exec(xml); r.version = v ? v[1] : '';
  const e = /<edition>([^<]*)<\/edition>/.exec(xml); r.edition = e ? e[1] : '';
  const ins = /<inputs>([\s\S]*?)<\/inputs>/.exec(xml);
  if (ins) for (const m of ins[1].matchAll(/<input\s([^>]*?)(\/>|>([\s\S]*?)<\/input>)/g)) {
    const a = attrs(m[1]);
    // its layers (MultiView, virtual set): <overlay index="0" key="..."/>
    const layers = [...String(m[3] || '').matchAll(/<overlay\s([^>]*?)\/?>/g)].map(o => attrs(o[1]).key).filter(Boolean);
    if (a.key) r.inputs.push({ key: a.key, number: parseInt(a.number, 10), title: a.title || a.shortTitle || `Input ${a.number}`, layers });
  }
  const ov = /<overlays>([\s\S]*?)<\/overlays>/.exec(xml);
  if (ov) for (const m of ov[1].matchAll(/<overlay\s([^>]*?)(?:\/>|>([^<]*)<\/overlay>)/g)) {
    const a = attrs(m[1]), n = parseInt(m[2], 10);
    if (n) r.overlays.push({ number: parseInt(a.number, 10), input: n, preview: /^true$/i.test(a.preview || '') });
  }
  // Mix 1 = the <active> / <preview> outside the <mix> blocks (Mix 2..16)
  const root = xml.replace(/<inputs>[\s\S]*?<\/inputs>/, '').replace(/<mix\s[\s\S]*?<\/mix>/g, '');
  const act = /<active>(\d+)<\/active>/.exec(root), pre = /<preview>(\d+)<\/preview>/.exec(root);
  r.active = act ? parseInt(act[1], 10) : 0; r.preview = pre ? parseInt(pre[1], 10) : 0;
  return r;
}

function tallyFrom(x) {
  const byNum = new Map(x.inputs.map(i => [i.number, i.key]));
  const byKey = new Map(x.inputs.map(i => [i.key, i]));
  const t = {};
  for (const i of x.inputs) t[i.key] = { pgm: [], pvw: [] };
  // an input, and the inputs shown inside it as layers (a few levels deep)
  const mark = (key, kind, where, depth = 0) => {
    if (!key || !t[key] || depth > 4) return;
    if (!t[key][kind].includes(where)) t[key][kind].push(where);
    for (const l of (byKey.get(key) || {}).layers || []) mark(l, kind, depth ? where : where + ' (layer)', depth + 1);
  };
  mark(byNum.get(x.active), 'pgm', 'PGM');
  mark(byNum.get(x.preview), 'pvw', 'PVW');
  for (const o of x.overlays) mark(byNum.get(o.input), o.preview ? 'pvw' : 'pgm', `Overlay ${o.number}`);
  return t;
}

class Session {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log; this.sock = null; this.buf = Buffer.alloc(0); this.want = 0;
    this.waiters = []; this.connected = false;
  }

  // one connection at a time, even when two reads start together
  _connect() {
    if (!this._connecting) this._connecting = this._open().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _open() {
    const s = new GuardedSocket('vmix', { host: this.cfg.host, port: this.cfg.port || PORT });
    s.onData = d => { if (this.sock === s) this._data(d); };
    s.onClose = () => { if (this.sock !== s) return; this.connected = false; this.sock = null; this._fail(new Error('connection closed')); };
    this.sock = s; this.buf = Buffer.alloc(0); this.want = 0;
    try { await s.connect(); } catch (e) { if (this.sock === s) this.sock = null; throw e; }
    if (this._closed) { s.close(); throw new Error('closed'); }
    this.connected = true;
    this.log.info(`Tally: connected to vMix at ${this.cfg.host}`);
  }

  _fail(e) { const w = this.waiters; this.waiters = []; w.forEach(x => x.reject(e)); }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 64 << 20) { this.buf = Buffer.alloc(0); this.want = 0; return; }
    for (;;) {
      if (this.want) {
        if (this.buf.length < this.want) return;
        const xml = this.buf.subarray(0, this.want).toString('utf8');
        this.buf = this.buf.subarray(this.want); this.want = 0;
        const w = this.waiters.shift(); if (w) w.resolve(xml);
        continue;
      }
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 2);
      const m = /^XML (\d+)$/.exec(line);
      if (m) this.want = parseInt(m[1], 10);
      else if (/^XML ER/.test(line)) { const w = this.waiters.shift(); if (w) w.reject(new Error(line)); }
    }
  }

  _xml() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('no answer')); this.close(); }, 4000);
      this.waiters.push({ resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      try { this.sock.send('XML\r\n'); } catch (e) { this.waiters.pop(); clearTimeout(t); reject(e); }
    });
  }

  async read() {
    if (!this.connected) await this._connect();
    const x = parseXml(await this._xml());
    this.lastXml = x;
    return { model: `vMix ${x.edition} ${x.version}`.trim(), inputs: x.inputs.map(i => ({ id: i.key, name: `${i.title}` , number: i.number })),
             tally: tallyFrom(x) };
  }

  debug() { return this.lastXml || null; }
  close() { this._closed = true; this.connected = false; const s = this.sock; this.sock = null; if (s) s.close(); this._fail(new Error('closed')); }
}

/** Scan: vMix greets with "VERSION OK ..." on 8099 (nothing is sent). */
function probe(host, { timeout = 1200, port = PORT } = {}) {
  return new Promise(resolve => {
    const s = new GuardedSocket('vmix-scan', { host, port, timeout });
    let t;
    s.onData = d => { const m = /^VERSION OK ([\d.]+)/.exec(d.toString()); clearTimeout(t); s.close(); resolve(m ? { model: 'vMix ' + m[1] } : null); };
    s.onClose = () => {};
    s.connect().then(() => { t = setTimeout(() => { s.close(); resolve(null); }, timeout); }, () => resolve(null));
  });
}

module.exports = {
  id: 'vmix', label: 'vMix', vendor: 'StudioCoast', port: PORT, portHint: 'TCP 8099', auth: null,
  scanPorts: [PORT], pollMs: 500, source: 'companion-module-studiocoast-vmix',
  RULES, FORBIDDEN, SCAN_RULES, create: (cfg, log) => new Session(cfg, log), probe, parseXml, tallyFrom,
};
