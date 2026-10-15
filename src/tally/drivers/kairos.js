'use strict';
/*
 * Panasonic KAIROS (Core / Creator): its REST API, HTTP port 1234 by
 * default. In KAIROS the REST API must be on, mode "Basic"; login: user
 * "Kairos" and the password set there (Settings).
 *
 * Protocol from the Bitfocus Companion module companion-module-panasonic-
 * kairos (MIT), Panasonic's KAIROS manual and kairos-go.
 *
 * Sent: only GET /inputs (every input with its name and its tally, computed
 * by KAIROS itself from its "tally roots": keys, PinP, nested scenes
 * included). KAIROS writes are PATCH requests: never sent. The TCP "simple
 * control" protocol (port 3005) is used for
 * nothing: querying a function attribute there EXECUTES it. The scan
 * only sends GET /inputs on the REST port.
 *
 * tally: bit 0 = red (on air), bit 1 = green (preview), by default (to
 * check on a real system: it depends on KAIROS's tally colour settings).
 */

const { httpClient, GuardedSocket, rule, register } = require('../guard');

const RULES = register('kairos', [rule('GET /inputs', /^GET \/inputs$/)]);
// the scan: one GET, the inputs (without login: a KAIROS answers 401 or the list)
const SCAN_RULES = register('kairos-scan', [rule('GET /inputs', /^GET \/inputs$/)]);
const FORBIDDEN = ['PATCH /inputs/1 {"name":"x"}', 'PATCH /scenes/1 {}', 'GET /scenes/1/cut', 'GET /inputs?x=1', 'POST /inputs'];

const request = httpClient('kairos');
const scanRequest = httpClient('kairos-scan');

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.ok = false; }

  async read() {
    const r = await request(`http://${this.cfg.host}:${this.cfg.port || 1234}/inputs`,
      { user: this.cfg.user || 'Kairos', password: this.cfg.password || '', preemptiveBasic: true, timeout: 2500 });
    if (r.status === 401 || r.status === 403) throw new Error('login refused (Settings: KAIROS REST user / password)');
    if (r.status >= 400) throw new Error(`HTTP ${r.status} (is the KAIROS REST API on, mode Basic?)`);
    let list;
    try { list = JSON.parse(r.body.toString()); } catch (_) { throw new Error('not a KAIROS answer'); }
    if (!Array.isArray(list)) throw new Error('not a KAIROS answer');
    if (!this.ok) { this.ok = true; this.log.info(`Tally: connected to the Panasonic KAIROS at ${this.cfg.host}`); }
    const inputs = list.map((i, n) => ({ id: String(i.uuid || i.index || n), name: i.name || `IN${i.index != null ? i.index : n + 1}` }));
    const tally = Object.fromEntries(list.map((i, n) => {
      const v = parseInt(i.tally, 10) || 0;
      return [inputs[n].id, { pgm: v & 1 ? ['On air'] : [], pvw: v & 2 ? ['Preview'] : [] }];
    }));
    return { model: 'Panasonic KAIROS', inputs, tally };
  }

  close() { this.ok = false; }
}

/** Scan: GET /inputs on the REST port: the list (no login set), or a 401 naming KAIROS. */
async function probe(host, opts = {}) {
  const r = await scanRequest(`http://${host}:${opts.port || 1234}/inputs`, { timeout: opts.timeout || 1500 });
  if (r.status === 401) return /kairos/i.test(String(r.headers['www-authenticate'] || '')) ? { model: 'Panasonic KAIROS', needsAuth: true } : null;
  let j; try { j = JSON.parse(r.body.toString()); } catch (_) { return null; }
  return Array.isArray(j) && j.length && j.every(i => i && typeof i === 'object' && 'tally' in i && 'name' in i) ? { model: 'Panasonic KAIROS' } : null;
}

module.exports = {
  id: 'kairos', label: 'Panasonic KAIROS', vendor: 'Panasonic', port: 1234, portHint: 'REST API, HTTP 1234',
  auth: 'userpass', defaultUser: 'Kairos', authHint: 'REST API login (user Kairos)', scanPorts: [1234], pollMs: 700,
  source: 'companion-module-panasonic-kairos', RULES, FORBIDDEN, SCAN_RULES,
  create: (cfg, log) => new Session(cfg, log), probe,
};
