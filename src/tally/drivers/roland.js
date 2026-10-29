'use strict';
/*
 * Roland V-160HD: LAN control, TCP port 8023, with its 4-digit network
 * password (MENU > LAN CONTROL > NETWORK PASSWORD).
 *
 * Protocol from Roland's "V-160HD Remote Control Guide" and the Bitfocus
 * Companion module companion-module-roland-v160hd (MIT).
 *
 * In this protocol "DTH:..." WRITES a parameter and "RQH:..." READS one.
 * Only these lines are ever sent:
 *   <password>              after the unit's "Enter password:"
 *   VER;                    model and version
 *   RQH:0C0000,000010;      tally of HDMI 1-8, SDI 1-8 (read-only area)
 * Each tally byte: bit 0 = PGM, bit 1 = PST (preview). Companion turns on
 * "tally auto send" (a DTH write): not here, the tally is read every 0.4 s.
 *
 * Not supported: V-60HD / XS-62S (one connection only: it would lock out
 * other control software), V-1200HD (no read command known), V-8HD,
 * V-1HD(+), V-02HD (no network control).
 */

const { GuardedSocket, rule, register } = require('../guard');

const PORT = 8023;
const TALLY = 'RQH:0C0000,000010;\n';
const NAMES = ['HDMI 1', 'HDMI 2', 'HDMI 3', 'HDMI 4', 'HDMI 5', 'HDMI 6', 'HDMI 7', 'HDMI 8',
  'SDI 1', 'SDI 2', 'SDI 3', 'SDI 4', 'SDI 5', 'SDI 6', 'SDI 7', 'SDI 8'];
const RULES = register('roland', [
  // the password line: 4 digits (it can't be a command); sent only after
  // "Enter password:" and only if it is the one typed in Settings
  rule('the 4-digit network password, after "Enter password:"', /^\d{4}\n$/),
  rule('VER; (model and version)', /^VER;\n$/),
  rule('RQH:0C0000,000010; (read the tally bytes)', /^RQH:0C0000,000010;\n$/),
]);
// the scan: nothing at all is sent (the unit greets by itself)
const SCAN_RULES = register('roland-scan', []);
const FORBIDDEN = ['DTH:0C0100,01;\n', 'DTH:002100,05;\n', 'CUT;\n', 'RQH:0C0000,000010;\nDTH:0C0100,01;\n', '12345\n', 'RQH:0B0000,000001;\n', '1234'];

const wait = ms => new Promise(r => setTimeout(r, ms));

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.sock = null; this.buf = ''; this.bytes = null; this.model = null; this.ver = null; this.rxAt = 0; }

  // one connection at a time, even when two reads start together
  _connect() {
    if (!this._connecting) this._connecting = this._open().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  _open() {
    if (this._closed) return Promise.reject(new Error('closed'));
    const pwd = String(this.cfg.password || '').trim();
    if (!/^\d{4}$/.test(pwd)) return Promise.reject(new Error('type the V-160HD network password (4 digits) in Settings'));
    const s = new GuardedSocket('roland', { host: this.cfg.host, port: this.cfg.port || PORT });
    // closed while logging in: this connection is closed too (it stayed open, review 2.2.2)
    this._pending = s;
    this.buf = ''; this.bytes = null; this.ver = null;
    return new Promise((resolve, reject) => {
      let state = 'login';
      const fail = e => { clearTimeout(t); s.close(); reject(e); };
      const t = setTimeout(() => fail(new Error(state === 'login' ? 'no password prompt (is it a V-160HD?)'
        : state === 'wait' ? 'password refused?' : 'no answer to VER (is it a V-160HD?)')), 4000);
      s.onData = d => {
        this.rxAt = Date.now();
        this.buf += d.toString('latin1');
        if (this.buf.length > 1 << 16) this.buf = '';
        if (state === 'login' && /Enter password:/i.test(this.buf)) { this.buf = ''; state = 'wait'; s.send(`${pwd}\n`); return; }
        if (state === 'wait') {
          const m = /Welcome to ([^.\r\n]+)/i.exec(this.buf);
          if (!m) return;
          this.model = 'Roland ' + m[1].trim(); this.buf = this.buf.slice(m.index + m[0].length); state = 'ver';
          s.send('VER;\n');
        }
        this._parse();
        if (state === 'ver' && this.ver) {
          clearTimeout(t);
          // nothing else is sent to another model (V-60HD...): it isn't read
          if (!/V-160HD/i.test(this.ver.model)) {
            s.close();
            const e = new Error(`${this.ver.model}: model not supported (V-160HD only)`); e.permanent = true;
            return reject(e);
          }
          if (this._closed) { state = 'closed'; s.close(); return reject(new Error('closed')); }
          state = 'ok'; this.sock = s; this._pending = null;
          this.log.info(`Tally: connected to the ${this.model} at ${this.cfg.host}`);
          resolve();
        }
      };
      s.onClose = () => { if (this.sock === s) this.sock = null; if (state !== 'ok') fail(new Error('connection closed (password refused?)')); };
      s.connect().catch(fail);
    });
  }

  _parse() {
    const parts = this.buf.split(/[;\n]/); this.buf = parts.pop();
    for (let p of parts) {
      p = p.replace(/[\x02\x06\x11\x13]/g, '').replace(/^ACK/, '').trim();
      let m;
      if ((m = /^VER:([^,]+),(.+)$/.exec(p))) { this.ver = { model: m[1].trim(), version: m[2].trim() }; this.model = `Roland ${this.ver.model} ${this.ver.version}`; }
      // whole bytes only (an odd number of hex digits is ignored: it crashed the app, review 2.2.2)
      else if ((m = /^DTH:0C0000,((?:[0-9A-F]{2})+)$/i.exec(p))) { this.bytes = m[1].match(/../g).map(h => parseInt(h, 16)); this.bytesAt = Date.now(); }
    }
  }

  async read() {
    if (!this.sock) await this._connect();
    const asked = Date.now();
    this.sock.send(TALLY);
    for (let w = 0; w < 30 && !(this.bytesAt >= asked); w++) await wait(50);
    // no fresh answer: the unit is gone (no frozen tally)
    if (!(this.bytesAt >= asked)) { this.close(); throw new Error('no tally answer from the Roland'); }
    const inputs = NAMES.map((n, i) => ({ id: String(i), name: n }));
    const tally = Object.fromEntries(inputs.map((x, i) => [x.id, { pgm: this.bytes[i] & 1 ? ['PGM'] : [], pvw: this.bytes[i] & 2 ? ['PST'] : [] }]));
    return { model: this.model || 'Roland V-160HD', inputs, tally };
  }

  close() {
    this._closed = true;
    const s = this.sock, p = this._pending; this.sock = null; this._pending = null; this.bytes = null;
    if (s) s.close();
    if (p && p !== s) p.close();
  }
}

/** Scan: the V-160HD greets with "Enter password:" (nothing is sent). */
function probe(host, { timeout = 1200, port = PORT } = {}) {
  return new Promise(resolve => {
    const s = new GuardedSocket('roland-scan', { host, port, timeout });
    let t, done = false;
    const end = v => { if (done) return; done = true; clearTimeout(t); s.close(); resolve(v); };
    s.onData = d => end(/Enter password/i.test(d.toString('latin1')) ? { model: 'Roland (V-160HD?)', needsAuth: true } : null);
    s.onClose = () => end(null);
    s.connect().then(() => { t = setTimeout(() => end(null), timeout); }, () => end(null));
  });
}

module.exports = {
  id: 'roland', label: 'Roland V-160HD', vendor: 'Roland', port: PORT, portHint: 'TCP 8023',
  auth: 'password', authHint: 'network password of the V-160HD (4 digits)', scanPorts: [PORT], pollMs: 400,
  source: 'companion-module-roland-v160hd', RULES, FORBIDDEN, SCAN_RULES, create: (cfg, log) => new Session(cfg, log), probe,
};
