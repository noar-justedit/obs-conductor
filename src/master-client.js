'use strict';
/*
 * Slave -> master: a JSON request, signed with the master's OBS password, and
 * its answer checked (auth.js, "X-OBSP-Seal"). Strict (Noar's choice, 2.3.0):
 *  - no OBS password on the master: nothing can be checked, refused;
 *  - an answer without seal (master older than 2.3.0, or something else
 *    answering at its address) or with a wrong one: refused.
 * Used by every slave request whose answer is used: state, playlist, scenes,
 * OBS settings, media list and fingerprints, update.
 */

const http = require('http');
const auth = require('./auth');

class MasterError extends Error {
  constructor(message, { status = null, kind = 'error' } = {}) { super(message); this.status = status; this.kind = kind; }
}

const NO_PASSWORD = 'the master\'s OBS has no WebSocket password: set one on the master (OBS: Tools > WebSocket Server Settings), then link it again';
const OLD_MASTER = 'the master doesn\'t sign its answers: update it to OBS Conductor 2.3.0 or newer';
const FORGED = 'an answer did not come from the master (wrong password, or another machine at its address): link the master again';

/** Checks a sealed answer; returns the parsed JSON (or throws MasterError). */
function checkAnswer(m, requestSig, status, sealHeader, body) {
  if (status === 401) throw new MasterError('the master refused: wrong password (link the master again)', { status, kind: 'password' });
  if (!sealHeader) throw new MasterError(OLD_MASTER, { status, kind: 'old' });
  if (!auth.answerOk(m.password, requestSig, body, sealHeader)) throw new MasterError(FORGED, { status, kind: 'forged' });
  let j;
  try { j = body ? JSON.parse(body) : {}; } catch (_) { throw new MasterError('the master sent an unreadable answer', { status }); }
  if (status >= 400) throw new MasterError((j && j.error) || `master answered HTTP ${status}`, { status });
  return j;
}

/**
 * GET `target` (path + query) on the master m = {host, port, password}.
 * Resolves with the checked JSON answer.
 */
function getJson(m, target, { timeout = 10000 } = {}) {
  if (!m.password) return Promise.reject(new MasterError(NO_PASSWORD, { kind: 'nopassword' }));
  return new Promise((resolve, reject) => {
    const sig = auth.sign(m.password, target);
    const req = http.get({ host: m.host, port: m.port, path: target, headers: { [auth.HEADER]: sig }, timeout }, res => {
      const parts = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 64 << 20) req.destroy(new Error('answer too big')); else parts.push(c); });
      res.on('end', () => {
        try { resolve(checkAnswer(m, sig, res.statusCode, res.headers[auth.RESP_HEADER], Buffer.concat(parts).toString('utf8'))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the master does not answer')));
    req.on('error', reject);
  });
}

/** The master of a slave config ({master_host, master_dashboard_port, master_obs_password}). */
const masterOf = cfg => ({ host: cfg.master_host, port: cfg.master_dashboard_port || 8090, password: cfg.master_obs_password || '' });

module.exports = { getJson, checkAnswer, masterOf, MasterError, NO_PASSWORD, OLD_MASTER, FORGED };
