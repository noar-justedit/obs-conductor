'use strict';
/*
 * Slave -> master requests that hand over something private (the scene
 * collection now, media files later) are signed with the master's OBS
 * WebSocket password, which the slave already knows (the user typed it to
 * link the slave). Nothing new to configure, and nobody else on the network
 * can read those files from the master.
 *
 *   header  X-OBSP-Auth: v2.<timestamp ms>.<HMAC-SHA256(password, "v2|GET|ts|path?query")>
 *
 * The password itself never travels. A signature is valid 2 minutes, for
 * that exact address (path AND query: a signature for one media file can't
 * fetch another). A master whose OBS has no password accepts everyone.
 * The 1.5.x form (ts.HMAC(ts + path), 5 minutes) is still accepted for the
 * update only, so an old slave can update itself from a new master.
 */

const crypto = require('crypto');

const HEADER = 'x-obsp-auth';
const MAX_SKEW_MS = 2 * 60 * 1000;
const LEGACY_SKEW_MS = 5 * 60 * 1000;

// Slave: how far the master's clock is from this PC's (read from the
// master's state every second). Signatures use the master's time, so two
// PCs whose clocks differ (no internet on a show network) still agree.
let clockSkew = 0;
const setClockSkew = ms => { if (Number.isFinite(ms)) clockSkew = Math.round(ms); };

const hmac = (password, text) => crypto.createHmac('sha256', String(password)).update(text).digest('base64url');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Header value for a GET of `target` (path and query, e.g. "/api/media/file?path=..."). */
function sign(password, target, now = Date.now() + clockSkew) {
  return `v2.${now}.${hmac(password || '', `v2|GET|${now}|${target}`)}`;
}

/** true when the request carries a valid signature for this password.
 *  `target`: the request's path + query (url.pathname + url.search). */
function verify(headerValue, password, target, now = Date.now()) {
  if (!password) return true;
  const parts = String(headerValue || '').split('.');
  if (parts[0] === 'v2' && parts.length === 3) {
    const t = parseInt(parts[1], 10);
    if (!Number.isFinite(t) || Math.abs(now - t) > MAX_SKEW_MS) return false;
    return same(hmac(password, `v2|GET|${t}|${target}`), parts[2]);
  }
  // 1.5.x slaves: their old signature, for the update only
  const pathname = String(target).split('?')[0];
  if (parts.length !== 2 || !pathname.startsWith('/api/update/')) return false;
  const t = parseInt(parts[0], 10);
  if (!Number.isFinite(t) || Math.abs(now - t) > LEGACY_SKEW_MS) return false;
  return same(hmac(password, `${t}${pathname}`), parts[1]);
}

/** Master -> slave: proof that a piece of data comes from the master (the
 *  update's version and fingerprint), with the same password. */
const seal = (password, text) => crypto.createHmac('sha256', 'seal|' + String(password || '')).update(String(text)).digest('base64url');
const sealOk = (password, text, sig) => {
  const want = Buffer.from(seal(password, text)), got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};
const updateText = (version, inst) => `${version}|${inst.size}|${inst.sha256}`;

/*
 * Master -> slave answers (2.3.0, review 2.2.2): every JSON answer to a
 * request carrying a signature is sealed by the master:
 *
 *   header  X-OBSP-Seal: HMAC-SHA256("resp|" + password, <the request's X-OBSP-Auth> + "|" + body)
 *
 * The slave checks it before using the answer: only the PC that knows the
 * OBS password can answer, and an answer can't be replayed for another
 * request (the request's signature carries its time and address). Strict
 * (Noar's choice): an answer without a valid seal is refused.
 */
const RESP_HEADER = 'x-obsp-seal';
const sealAnswer = (password, requestSig, body) => crypto.createHmac('sha256', 'resp|' + String(password || ''))
  .update(String(requestSig) + '|').update(body).digest('base64url');
const answerOk = (password, requestSig, body, sig) => {
  const want = Buffer.from(sealAnswer(password, requestSig, body)), got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};

module.exports = { sign, verify, HEADER, setClockSkew, seal, sealOk, updateText, RESP_HEADER, sealAnswer, answerOk };
