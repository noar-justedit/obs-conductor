'use strict';
/*
 * READ-ONLY GUARD of the tally (ABSOLUTE RULE, Noar):
 *
 *   OBS Conductor NEVER sends a command to a switcher. Never a cut, a take,
 *   a source change, a preset recall, a setting change. It READS.
 *
 * Allowed (Noar's choice, 2.2): reads, plus what some machines need before
 * they let you read: opening a session (ATEM), a login / password (Roland,
 * Analog Way, Kairos, TriCaster), a subscription to changes. Nothing that
 * changes what the machine shows or how it is set.
 *
 * How it is enforced: a driver never opens a network connection itself
 * (a test checks that no driver file loads net, dgram, http, https or tls).
 * Every message it sends goes through this file, checked against the
 * driver's own CLOSED list of allowed messages (its RULES, registered here
 * once and frozen: a caller can't hand in another list). Anything else is
 * refused before it leaves the PC (error "refused"). Each driver's list is
 * tested with messages that must be refused (test/tally-drivers.test.js).
 *
 * STOP TALLY (Noar, 2.2.1): one switch cuts the whole tally. While it is on,
 * nothing at all leaves through this file: no connection is opened, no
 * byte is sent, and every connection already open is closed at once. It is
 * ON when the app starts (tally cut by default, until Noar approves the
 * tally); the dock turns it off. The OBS WebSocket and the master / slave
 * links don't go through this file: they keep working.
 *
 * Adding a machine: its RULES are the list of the exact read messages, and
 * nothing more. See docs/TALLY-DEVICES.md.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');

const MAX_ANSWER = 32 << 20;          // an answer bigger than this is cut off

// ---- STOP TALLY: the kill switch ------------------------------------------------

let cut = true;                         // the tally starts CUT
const live = new Set();                 // every open connection / request, closed by the cut

class Cut extends Error {
  constructor() { super('the tally is stopped (Stop tally): nothing is sent'); this.cut = true; }
}
const isCut = () => cut;
function setCut(on) {
  cut = !!on;
  if (cut) for (const x of [...live]) { try { x.destroy ? x.destroy(new Cut()) : x.close(); } catch (_) {} live.delete(x); }
  return cut;
}

class Refused extends Error {
  constructor(driver, what) {
    super(`refused: ${what} is not a read (the tally is read only)`);
    this.refused = true; this.driver = driver;
  }
}

// tests: every message that really leaves the PC, driver by driver
const watchers = new Set();
function onOutbound(fn) { watchers.add(fn); return () => watchers.delete(fn); }
function report(driver, kind, msg) { for (const w of watchers) try { w({ driver, kind, msg }); } catch (_) {} }

/** A rule: {desc, test(message) -> bool}. RegExp-based helper. */
// source / flags: only to LOCK the lists by a test (test/tally-rules.test.js), never used to decide
const rule = (desc, re) => Object.freeze({ desc, source: re.source, flags: re.flags, test: s => typeof s === 'string' && re.test(s) });

/** Does one of these rules allow this message? */
function allowed(rules, msg) { return rules.some(r => r.test(msg)); }

// the closed lists, one per driver id, registered once by the driver itself
const REGISTRY = new Map();
function register(id, rules) {
  if (REGISTRY.has(id)) throw new Error(`tally rules of ${id} registered twice`);
  // the rules themselves are frozen too: nobody can swap a rule's test afterwards
  const list = Object.freeze([...rules].map(r => Object.freeze(r)));
  REGISTRY.set(id, list);
  return list;
}
function rulesOf(id) {
  const r = REGISTRY.get(id);
  if (!r) throw new Error(`no read list for ${id}`);
  return r;
}

// ---- HTTP -----------------------------------------------------------------

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

/** Authorization header answering a 401 (Basic or Digest), or null. */
function authHeader(www, method, uri, user, password) {
  if (!www || user == null) return null;
  if (/^\s*basic/i.test(www)) return 'Basic ' + Buffer.from(`${user}:${password || ''}`).toString('base64');
  if (!/^\s*digest/i.test(www)) return null;
  const p = {};
  www.replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_, k, a, b) => { p[k.toLowerCase()] = a != null ? a : b; return ''; });
  const ha1 = md5(`${user}:${p.realm}:${password || ''}`), ha2 = md5(`${method}:${uri}`);
  const qop = p.qop && p.qop.split(',').map(s => s.trim()).includes('auth') ? 'auth' : null;
  const nc = '00000001', cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${response}"`;
  if (p.opaque) h += `, opaque="${p.opaque}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  return h;
}

/**
 * An HTTP client that can only send what the driver's rules allow. A rule
 * tests the string "METHOD /path?query" (+ " " + body when there is one).
 * Redirects are never followed. request(url, {method, body, headers,
 * timeout, user, password, preemptiveBasic}) -> {status, headers, body}
 */
function httpClient(driver) {
  const rules = rulesOf(driver);
  return function request(url, o = {}) {
    const method = o.method || 'GET';
    let u;
    try { u = new URL(url); } catch (_) { return Promise.reject(new Error('bad address')); }
    if (u.username || u.password) return Promise.reject(new Error('bad address'));
    const target = u.pathname + u.search;
    const body = o.body == null ? null : String(o.body);
    const msg = `${method} ${target}` + (body != null ? ' ' + body : '');
    if (!allowed(rules, msg)) return Promise.reject(new Refused(driver, `${method} ${target}`));
    const timeout = o.timeout || 3000;
    const send = auth => new Promise((resolve, reject) => {
      if (cut) return reject(new Cut());
      report(driver, 'http', msg);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = { Connection: 'close', ...(o.headers || {}) };
      if (auth) headers.Authorization = auth;
      if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
      let req;
      // whole answer within twice the timeout, whatever the trickle
      const limit = setTimeout(() => req && req.destroy(new Error('no answer')), timeout * 2);
      req = mod.request(u, { method, headers, timeout, rejectUnauthorized: false }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', c => { size += c.length; if (size > MAX_ANSWER) req.destroy(new Error('answer too big')); else chunks.push(c); });
        res.on('end', () => { clearTimeout(limit); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
        res.on('error', e => { clearTimeout(limit); reject(e); });
      });
      live.add(req);
      req.on('close', () => live.delete(req));
      req.on('timeout', () => req.destroy(new Error('no answer')));
      req.on('error', e => { clearTimeout(limit); reject(e); });
      if (body != null) req.write(body);
      req.end();
    });
    const basic = o.user != null && o.preemptiveBasic ? 'Basic ' + Buffer.from(`${o.user}:${o.password || ''}`).toString('base64') : null;
    return send(basic).then(r => {
      // 401: the very same request again (same method, path, body), with the
      // login (Basic or Digest), once
      if (r.status !== 401 || o.user == null || basic) return r;
      const h = authHeader(r.headers['www-authenticate'], method, target, o.user, o.password);
      return h ? send(h) : r;
    });
  };
}

// ---- TCP, line protocols ----------------------------------------------------

/**
 * A TCP connection that can only send what the driver's rules allow (each
 * message tested whole, line ending included). onData(Buffer), onClose().
 */
class GuardedSocket {
  constructor(driver, { host, port, timeout = 3000 }) {
    this.driver = driver; this.rules = rulesOf(driver);
    this.host = host; this.port = port; this.timeout = timeout;
    this.sock = null; this.closed = false; this.onData = () => {}; this.onClose = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (cut) return reject(new Cut());
      const s = net.connect({ host: this.host, port: this.port });
      this.sock = s;
      live.add(s);
      s.on('close', () => live.delete(s));
      let up = false;
      const t = setTimeout(() => { s.destroy(new Error('no answer')); }, this.timeout);
      s.once('connect', () => { up = true; clearTimeout(t); s.setNoDelay(true); s.setKeepAlive(true, 2000); resolve(); });
      // a driver's mistake on a strange answer closes this connection, never the app (review 2.2.2)
      s.on('data', d => { try { this.onData(d); } catch (e) { s.destroy(e); } });
      s.on('error', e => { clearTimeout(t); if (!up) reject(e); });
      s.on('close', () => { clearTimeout(t); this.closed = true; if (!up) reject(new Error('connection closed')); try { this.onClose(); } catch (_) {} });
    });
  }

  send(msg) {
    if (cut) throw new Cut();
    if (typeof msg !== 'string' || !allowed(this.rules, msg)) throw new Refused(this.driver, JSON.stringify(msg));
    if (!this.sock || this.sock.destroyed) throw new Error('not connected');
    report(this.driver, 'tcp', msg);
    this.sock.write(msg);
  }

  close() { this.closed = true; try { this.sock && this.sock.destroy(); } catch (_) {} }
}

// ---- UDP (ATEM: two fixed packet shapes, see drivers/atem.js) ----------------

/** A UDP socket that can only send what the driver's rules allow (a rule
 *  tests the Buffer). onMessage(buf, rinfo), onError(err). */
class GuardedUdp {
  constructor(driver) {
    this.driver = driver; this.rules = rulesOf(driver);
    this.sock = dgram.createSocket('udp4');
    live.add(this);
    this.onMessage = () => {}; this.onError = () => {};
    this.sock.on('message', (m, r) => { try { this.onMessage(m, r); } catch (e) { try { this.onError(e); } catch (_) {} } });
    this.sock.on('error', e => this.onError(e));
  }

  bind() {
    return new Promise((resolve, reject) => {
      if (cut) { this.close(); return reject(new Cut()); }
      const fail = e => reject(e);
      this.sock.once('error', fail);
      try { this.sock.bind(0, () => { this.sock.off('error', fail); resolve(); }); } catch (e) { reject(e); }
    });
  }

  send(buf, port, host) {
    if (cut) throw new Cut();
    if (!Buffer.isBuffer(buf) || !allowed(this.rules, buf)) throw new Refused(this.driver, 'UDP packet ' + (Buffer.isBuffer(buf) ? buf.toString('hex') : typeof buf));
    report(this.driver, 'udp', buf.toString('hex'));
    this.sock.send(buf, port, host);
  }

  close() { live.delete(this); try { this.sock.close(); } catch (_) {} }
}

/** The scan's port check: a TCP connection, closed at once, nothing sent. */
function tcpOpen(host, port, timeoutMs) {
  return new Promise(resolve => {
    if (cut) return resolve(false);
    const s = net.connect({ host, port });
    live.add(s);
    const done = ok => { s.destroy(); live.delete(s); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

module.exports = { Refused, Cut, rule, allowed, register, rulesOf, httpClient, GuardedSocket, GuardedUdp, tcpOpen,
                   onOutbound, authHeader, isCut, setCut, liveCount: () => live.size };
