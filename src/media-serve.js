'use strict';
/*
 * Master: hands its media files to the slaves (their "Sync"), through the
 * app's own HTTP server - no Windows share to set up.
 *
 * Only the files used by the master's open scene collection can be fetched,
 * and only by a slave that signs its requests with the master's OBS
 * password (auth.js).
 *
 * Each file has a fingerprint (SHA-256) the slave checks its copy against.
 * Computing it means reading the whole file once: it is done while the file
 * is sent (no extra reading) and kept in media-hashes.json, so it is only
 * computed again when the file changes (size or date).
 */

const fs = require('fs');
const crypto = require('crypto');

class MediaServer {
  constructor(cacheFile, log) {
    this.cacheFile = cacheFile;
    this.log = log;
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch (_) {}
  }

  static key(p, st) { return `${p}|${st.size}|${Math.round(st.mtimeMs)}`; }

  _remember(key, hash) {
    this.cache[key] = hash;
    try { fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache)); } catch (_) {}
  }

  /** [{path, size, mtime (ms), missing}] for these paths. */
  list(paths) {
    return paths.map(p => {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return { path: p, missing: true };
        return { path: p, size: st.size, mtime: Math.round(st.mtimeMs) };
      } catch (_) { return { path: p, missing: true }; }
    });
  }

  /** SHA-256 (hex) of a file, from the cache or computed now. */
  async hash(p) {
    const st = fs.statSync(p);
    const key = MediaServer.key(p, st);
    if (this.cache[key]) return this.cache[key];
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(p, { highWaterMark: 4 << 20 }).on('data', c => h.update(c)).on('end', resolve).on('error', reject);
    });
    const hex = h.digest('hex');
    this._remember(key, hex);
    return hex;
  }

  /** Sends a file, whole or from a byte offset (Range: bytes=N-) to resume. */
  serve(req, res, p) {
    let st;
    try { st = fs.statSync(p); } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'file not found on the master' }));
    }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = m ? Math.min(parseInt(m[1], 10), st.size) : 0;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size - start,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'X-Size': st.size, 'X-Mtime': Math.round(st.mtimeMs),
    };
    if (start) headers['Content-Range'] = `bytes ${start}-${st.size - 1}/${st.size}`;
    res.writeHead(start ? 206 : 200, headers);
    if (start >= st.size) return res.end();
    const key = MediaServer.key(p, st);
    // a whole file sent: its fingerprint comes for free
    const h = !start && !this.cache[key] ? crypto.createHash('sha256') : null;
    const stream = fs.createReadStream(p, { start, highWaterMark: 4 << 20 });
    if (h) stream.on('data', c => h.update(c));
    stream.on('end', () => { if (h) this._remember(key, h.digest('hex')); });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

module.exports = { MediaServer };
