'use strict';
/*
 * Analog Way LiveCore: Ascender 16 / 32 / 48 (and their 4K versions),
 * NeXtage 08 / 16, SmartMatriX Ultra. TCP text protocol, port 10600
 * (10500 or 10400 if set so on the unit).
 *
 * Protocol from Analog Way's "LiveCore TPP Programmer's Guide" v03.00.88
 * and the Bitfocus Companion module companion-module-analogway-livecore
 * (MIT).
 *
 * In this protocol a READ and a WRITE look alike: "0,1SPscl" WRITES (a value
 * glued to the 5-letter command), "0,SPscl" READS (no value). Only these
 * read lines are ever sent:
 *   ?            device type -> DEV<n>
 *   <i>,TAopr    program tally of source i -> TAopr<i>,<0|1>
 *   <i>,TAopw    preview tally of source i -> TAopw<i>,<0|1>
 * The tally is computed by the unit (all screens). The unit may also send
 * changes by itself: they are read the same way. Input names can't be read
 * in this protocol: the inputs are "Source 1, 2..." (numbers of the unit).
 */

const { GuardedSocket, rule, register } = require('../guard');

const PORT = 10600;
const SOURCES = 48;
const RULES = register('livecore', [
  rule('? (device type)', /^\?\n$/),
  rule('<i>,TAopr (program tally of source i, read)', /^\d{1,2},TAopr\n$/),
  rule('<i>,TAopw (preview tally of source i, read)', /^\d{1,2},TAopw\n$/),
]);
// the scan: nothing at all is sent (the unit greets by itself)
const SCAN_RULES = register('livecore-scan', []);
const FORBIDDEN = ['1,1TAopr\n', '0,1SPscl\n', '1TPdie\n', '3TPdie\n', '0,1PMloa\n', '1,TAopr\n0,1SPCtk\n', '1,TAopr', 'TAopr\n'];

const DEVICES = { 97: 'NeXtage 16', 98: 'SmartMatriX Ultra', 99: 'Ascender 32', 100: 'Ascender 48', 105: 'NeXtage 16 4K',
  106: 'SmartMatriX Ultra 4K', 107: 'Ascender 32 4K', 108: 'Ascender 48 4K', 112: 'Ascender 16', 113: 'Ascender 16 4K',
  114: 'Ascender 48 4K PL', 116: 'NeXtage 08', 117: 'NeXtage 08 4K', 118: 'Ascender 32 4K PL' };

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.sock = null; this.buf = ''; this.pgm = new Map(); this.pvw = new Map(); this.model = null; this.at = 0; this.rxAt = 0; }

  // one connection at a time, even when two reads start together
  _connect() {
    if (!this._connecting) this._connecting = this._open().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _open() {
    const s = new GuardedSocket('livecore', { host: this.cfg.host, port: this.cfg.port || PORT });
    s.onData = d => { if (this.sock === s) this._data(d.toString('latin1')); };
    s.onClose = () => { if (this.sock === s) this.sock = null; };
    this.sock = s; this.buf = ''; this.pgm.clear(); this.pvw.clear(); this.slave = false;
    try { await s.connect(); } catch (e) { if (this.sock === s) this.sock = null; throw e; }
    if (this._closed) { s.close(); throw new Error('closed'); }
    this.rxAt = Date.now();
    s.send('?\n');
    this._askAll();
  }

  _askAll() { for (let i = 1; i <= SOURCES; i++) { this.sock.send(`${i},TAopr\n`); this.sock.send(`${i},TAopw\n`); } this.at = Date.now(); }

  _data(txt) {
    this.rxAt = Date.now();
    this.buf += txt;
    if (this.buf.length > 1 << 20) this.buf = '';
    let i;
    while ((i = this.buf.search(/\r?\n/)) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i).replace(/^\r?\n/, '');
      let m;
      if ((m = /^TPcon(\d+),(\d+)/.exec(line)) && m[1] !== '0') this.slave = true;
      else if ((m = /^DEV(\d+)/.exec(line))) {
        this.model = 'Analog Way ' + (DEVICES[m[1]] || `LiveCore (type ${m[1]})`);
        this.log.info(`Tally: connected to the ${this.model} at ${this.cfg.host}`);
      } else if ((m = /^TAop([rw])(\d+),(\d+)/.exec(line))) (m[1] === 'r' ? this.pgm : this.pvw).set(parseInt(m[2], 10), m[3] === '1');
    }
  }

  async read() {
    if (!this.sock) await this._connect();
    if (this.slave) throw new Error('this unit is a slave: type the address of the master unit');
    // read again every 2 s, in case the unit doesn't send its changes; no
    // answer for 5 s while asking: the unit is gone (no frozen tally)
    if (Date.now() - this.at > 2000) this._askAll();
    if (Date.now() - this.rxAt > 5000) { this.close(); throw new Error('the LiveCore unit stopped answering'); }
    for (let w = 0; w < 20 && !this.pgm.size; w++) await new Promise(r => setTimeout(r, 100));
    if (!this.pgm.size) throw new Error('no answer from the LiveCore unit');
    const ids = [...new Set([...this.pgm.keys(), ...this.pvw.keys()])].sort((a, b) => a - b);
    const inputs = ids.map(i => ({ id: String(i), name: `Source ${i}` }));
    const tally = Object.fromEntries(ids.map(i => [String(i), { pgm: this.pgm.get(i) ? ['PGM'] : [], pvw: this.pvw.get(i) ? ['PVW'] : [] }]));
    return { model: this.model || 'Analog Way LiveCore', inputs, tally };
  }

  close() { this._closed = true; const s = this.sock; this.sock = null; if (s) s.close(); }
}

/** Scan: a LiveCore unit greets with "TPcon0,<n>" by itself: nothing is sent. */
function probe(host, { timeout = 1500, port = PORT } = {}) {
  return new Promise(resolve => {
    const s = new GuardedSocket('livecore-scan', { host, port, timeout });
    let t, done = false;
    const end = v => { if (done) return; done = true; clearTimeout(t); s.close(); resolve(v); };
    s.onData = d => end(/TPcon\d+,\d+/.test(d.toString('latin1')) ? { model: 'Analog Way LiveCore (Ascender...)' } : null);
    s.onClose = () => end(null);
    s.connect().then(() => { t = setTimeout(() => end(null), timeout); }, () => end(null));
  });
}

module.exports = {
  id: 'livecore', label: 'Analog Way Ascender (LiveCore)', vendor: 'Analog Way', port: PORT, portHint: 'TCP 10600',
  auth: null, scanPorts: [PORT], pollMs: 500, source: 'companion-module-analogway-livecore',
  RULES, FORBIDDEN, SCAN_RULES, create: (cfg, log) => new Session(cfg, log), probe,
};
