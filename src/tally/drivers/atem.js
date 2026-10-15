'use strict';
/*
 * Blackmagic ATEM switchers (ATEM Mini family, Television Studio,
 * Constellation, 1/2/4 M/E...): UDP port 9910.
 *
 * Protocol from atem-connection (the library of the Bitfocus Companion
 * module companion-module-bmd-atem, MIT) and pyatem.
 *
 * The ATEM sends its whole state by itself once a session is open, then
 * every change. To get it, a client sends only two things:
 *   - the "hello" that opens the session (20 bytes, always the same);
 *   - acknowledgements of the packets it receives (12 bytes, no content).
 * Nothing else is ever sent: no command can be built here (GuardedUdp refuses
 * any other packet). State-changing ATEM commands (CPgI, CPvI, DCut...) are
 * packets with a content, which this file has no way to make.
 *
 * What is read (packet contents from the ATEM):
 *   _pin  product name ("ATEM Mini Pro")
 *   InPr  inputs: id, long name, short name, port type (0 = external input)
 *   TlSr  tally by source: bit 0 = on PROGRAM, bit 1 = in PREVIEW, computed
 *         by the ATEM itself (keys, DSK, SuperSource included, like its
 *         multiviewer's red / green borders)
 *   InCm  end of the initial state
 */

const dns = require('dns');
const { GuardedUdp, register } = require('../guard');

const PORT = 9910;
// the hello, always the same 20 bytes (a fresh copy each time: a Buffer can't be frozen)
const hello = () => Buffer.from('101453ab00000000003a00000100000000000000', 'hex');
const F_ACK_REQUEST = 0x01, F_HELLO = 0x02, F_ACK = 0x10;
const TIMEOUT_MS = 5000;

/** The acknowledgement of packet `id` (the only other packet ever sent). */
function ackPacket(session, id) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE((F_ACK << 11) | 12, 0);
  b.writeUInt16BE(session & 0xffff, 2);
  b.writeUInt16BE(id & 0x7fff, 4);
  return b;
}

/** The two shapes allowed out: the hello, an ack (flag 0x10, no content). */
function isAllowedPacket(b) {
  if (!Buffer.isBuffer(b)) return false;
  if (b.equals(hello())) return true;
  return b.length === 12 && b.readUInt16BE(0) === ((F_ACK << 11) | 12) && b.readUInt16BE(6) === 0 &&
         b.readUInt16BE(8) === 0 && b.readUInt16BE(10) === 0;
}
const RULES = register('atem', [
  { desc: 'UDP hello (opens the session): 10 14 53 ab 00 00 00 00 00 3a 00 00 01 00 00 00 00 00 00 00', test: isAllowedPacket },
  { desc: 'UDP acknowledgement: 12 bytes, flag 0x10, no content', test: isAllowedPacket },
]);
// a cut, a preview change, an ack carrying a command: all refused
const FORBIDDEN = [
  Buffer.from('080c0001000000000000000100104350674900000001', 'hex'),
  Buffer.from('881800010000000000000002000c44437574000000', 'hex'),
  Buffer.concat([ackPacket(1, 1), Buffer.from('000c4350764900000002', 'hex')]),
];

const cstr = (b, start, len) => { const s = b.subarray(start, start + len); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8').trim(); };

/** Commands inside a packet's content: [name, body]. */
function* commands(payload) {
  let buf = payload;
  while (buf.length >= 8) {
    const len = buf.readUInt16BE(0);
    if (len < 8 || len > buf.length) break;
    yield [buf.toString('ascii', 4, 8), buf.subarray(8, len)];
    buf = buf.subarray(len);
  }
}

class Session {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log;
    this.host = cfg.host; this.port = cfg.port || PORT;
    this.inputs = new Map(); this.tally = new Map(); this.model = 'ATEM';
    this.ready = false; this.error = null; this.sock = null; this.addr = null;
    this._open();
    this._watch = setInterval(() => {
      if (Date.now() - this.lastRx > TIMEOUT_MS) { this.ready = false; this.error = 'no answer'; this._open(); }
    }, 1000);
  }

  _send(buf) { if (this.sock) this.sock.send(buf, this.port, this.addr || this.host); }

  _open() {
    if (this.sock) this.sock.close();
    this.session = 0; this.last = -1; this.lastRx = Date.now();
    this.inputs = new Map(); this.tally = new Map();
    const s = this.sock = new GuardedUdp('atem');
    s.onError = e => { this.error = e.message; };
    // only the ATEM's own packets count (its address and port)
    s.onMessage = (m, r) => { if (this.sock === s && r.port === this.port && (!this.addr || r.address === this.addr)) this._rx(m); };
    dns.lookup(this.host, { family: 4 }, (err, addr) => {
      if (this.sock !== s) return;
      if (err) { this.error = `address not found (${this.host})`; return; }
      this.addr = addr;
      s.bind().then(() => this._send(hello()), e => { this.error = e.message; });
    });
  }

  _rx(m) {
    if (m.length < 12) return;
    const flags = m[0] >> 3, len = m.readUInt16BE(0) & 0x07ff;
    if (len !== m.length) return;
    this.lastRx = Date.now();
    this.session = m.readUInt16BE(2);
    const id = m.readUInt16BE(10);
    if (flags & F_HELLO) {
      // session accepted (payload byte 0 = 0x02)
      if (m.length >= 13 && m[12] !== 0x02) { this.error = 'the ATEM refused the connection (no free slot?)'; return; }
      this.last = id; this._send(ackPacket(this.session, id));
      return;
    }
    if (!(flags & F_ACK_REQUEST) || this.last < 0) return;
    const dist = (id - this.last + 32768) % 32768;
    if (dist === 1) {
      this.last = id;
      if (m.length > 12) this._parse(m.subarray(12));
    }
    // in order: acknowledged; already seen: acknowledged again; after a gap:
    // not acknowledged (the ATEM sends the missing ones again)
    if (dist === 1 || dist === 0 || dist > 256) this._send(ackPacket(this.session, this.last));
  }

  _parse(payload) {
    for (const [name, b] of commands(payload)) {
      if (name === '_pin' && b.length >= 1) this.model = cstr(b, 0, 40) || 'ATEM';
      else if (name === 'InPr' && b.length >= 33) {
        const id = b.readUInt16BE(0);
        this.inputs.set(id, { id, long: cstr(b, 2, 20), short: cstr(b, 22, 4), type: b[32] });
      } else if (name === 'TlSr' && b.length >= 2) {
        const n = b.readUInt16BE(0), t = new Map();
        for (let i = 0; i < n && 4 + i * 3 < b.length; i++) t.set(b.readUInt16BE(2 + i * 3), b[4 + i * 3]);
        this.tally = t;
      } else if (name === 'InCm') {
        if (!this.ready) this.log.info(`Tally: connected to the ${this.model} at ${this.host}`);
        this.ready = true; this.error = null;
      }
    }
  }

  async read() {
    if (!this.ready) {
      // the first state takes a moment: wait a little
      for (let i = 0; i < 30 && !this.ready; i++) await new Promise(r => setTimeout(r, 100));
      if (!this.ready) throw new Error(this.error || 'no answer from the ATEM');
    }
    const inputs = [...this.inputs.values()].filter(i => i.type === 0).sort((a, b) => a.id - b.id)
      .map(i => ({ id: String(i.id), name: i.long || i.short || `Input ${i.id}` }));
    const tally = {};
    for (const i of inputs) {
      const v = this.tally.get(Number(i.id)) || 0;
      tally[i.id] = { pgm: v & 1 ? ['PGM'] : [], pvw: v & 2 ? ['PVW'] : [] };
    }
    return { model: this.model, inputs, tally };
  }

  debug() { return { model: this.model, inputs: [...this.inputs.values()], tally: Object.fromEntries(this.tally) }; }

  close() { clearInterval(this._watch); const s = this.sock; this.sock = null; if (s) s.close(); }
}

module.exports = {
  id: 'atem', label: 'Blackmagic ATEM', vendor: 'Blackmagic Design',
  port: PORT, portHint: 'UDP 9910', auth: null, scanPorts: [], scanHint: 'not scanned (it would open a session on any device): choose it in the list', pollMs: 300,
  source: 'companion-module-bmd-atem (atem-connection)',
  RULES, FORBIDDEN, create: (cfg, log) => new Session(cfg, log),
  hello, ackPacket, isAllowedPacket,
};
