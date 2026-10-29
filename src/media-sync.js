'use strict';
/*
 * Slave: copies the master's media onto this PC, app to app (port 8090, the
 * one already open) - no Windows share.
 *
 *   1. asks the master for the files its scenes use (path, size, date);
 *   2. where each one goes here: the same path, or another folder chosen
 *      for a master folder whose drive doesn't exist here (mappings);
 *   3. a file already here with the same size and date is left alone;
 *   4. the others are downloaded next to their place (".obsc-part"), resumed
 *      where they stopped if the copy was cut, then checked against the
 *      master's fingerprint (SHA-256): a copy that differs is fetched again;
 *   5. the old version, if any, goes to an archive folder, dated - nothing
 *      is ever deleted - then the new one takes its place, with the master's
 *      date;
 *   6. a file this sync copied before and that the master no longer uses
 *      also goes to the archive.
 *
 * A file OBS is playing here can't be replaced (Windows locks it): its new
 * version waits next to it and takes its place at the next Sync.
 */

const mc = require('./master-client');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const C = require('./collection');

const PART = '.obsc-part';
const SAME_TIME_MS = 2000;   // FAT / exFAT dates are rounded to 2 s

const stamp = () => {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
};

/** The folder a local media belongs to: the folder chosen for its master
 *  folder, or its top folder (D:\Media for D:\Media\Show\a.mov). */
function localRoot(localPath, mappings) {
  const lp = localPath.toLowerCase();
  const m = (mappings || []).find(x => { if (!x.to) return false; const t = x.to.toLowerCase().replace(/[\\/]+$/, '');
    return lp === t || lp.startsWith(t + '\\') || lp.startsWith(t + '/'); });
  if (!m) return C.mediaRoot(localPath);
  const to = m.to.replace(/[\\/]+$/, '');
  return /^[a-z]:$/i.test(to) ? to + '\\' : to;    // a whole drive keeps its "\" (E:\ not E:)
}

/** "D:\Media" -> "D:\Media (archive)"; a whole drive -> "D:\OBS Conductor archive". */
function archiveRootFor(localPath, mappings) {
  const root = localRoot(localPath, mappings);
  // a whole drive, or a network share (\\server\share: no folder next to it)
  if (/[\\/]$/.test(root) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+$/.test(root)) return path.join(root, 'OBS Conductor archive');
  return root + ' (archive)';
}

/** Where a local file goes when archived: <archive root>\<date>\<path under the root>. */
function archivePathFor(localPath, when, mappings) {
  const root = localRoot(localPath, mappings);
  const rel = localPath.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
  return path.join(archiveRootFor(localPath, mappings), when, rel);
}

// Security (review 1.5.4): the master says which files to write here. A
// hijacked or fake master must not be able to drop a program on this PC
// (e.g. in the Startup folder). Refused: ".." in the path, program / script
// files, and the system's own folders (Windows, macOS, Linux).
const DENY_EXT = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.msi', '.msp', '.scr', '.pif', '.lnk', '.url', '.dll', '.sys', '.cpl', '.hta', '.reg', '.jar', '.inf', '.appref-ms',
  // macOS / Linux
  '.sh', '.bash', '.zsh', '.command', '.tool', '.app', '.pkg', '.dmg', '.dylib', '.kext', '.plist', '.scpt', '.applescript',
  '.so', '.deb', '.rpm', '.appimage', '.desktop', '.service', '.py', '.pl', '.rb',
  // OBS scripts (review 2.2.2): OBS runs them when a scene collection lists them
  '.lua', '.luac', '.pyc']);
const DENY_DIRS = [/^[a-z]:[\\/]windows[\\/]/i, /^[a-z]:[\\/]program files( \(x86\))?[\\/]/i, /^[a-z]:[\\/]programdata[\\/]microsoft[\\/]/i,
  /[\\/]start menu[\\/]/i, /[\\/]startup[\\/]/i, /[\\/]appdata[\\/]roaming[\\/]microsoft[\\/]/i,
  // macOS / Linux: system folders, things started at logon, shell settings
  /^\/(system|bin|sbin|usr|etc|var|private|boot|lib|lib64|opt|applications)\//i, /\/library\/(launchagents|launchdaemons|startupitems)\//i,
  /\/\.config\/(autostart|systemd)\//i, /\/\.local\/share\/applications\//i, /\/\.ssh\//i,
  /\/\.(bashrc|bash_profile|profile|zshrc|zprofile|zshenv)$/i];
function unsafeTarget(p) {
  const s = String(p || '');
  if (s.split(/[\\/]+/).includes('..')) return 'path with ".."';
  const m = /\.[^.\\/]+$/.exec(s);
  if (m && DENY_EXT.has(m[0].toLowerCase())) return 'program or script file';
  if (DENY_DIRS.some(r => r.test(s))) return 'system folder';
  return null;
}

/** The disk a path is on, to add up the room needed: "e:", "\\\\nas\\media", "/". */
function volumeKey(p) {
  const s = String(p || '');
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(s);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase();
  const d = /^([a-z]):/i.exec(s);
  return d ? d[1].toLowerCase() + ':' : '/';
}

/** Does the top folder / drive of this path exist on this PC? */
function rootExists(p) {
  const r = C.mediaRoot(p);
  const drive = /^[a-zA-Z]:/.test(r) ? r.slice(0, 2) + path.sep : r;
  try { return fs.existsSync(/^[a-zA-Z]:/.test(r) ? drive : r); } catch (_) { return false; }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p, { highWaterMark: 4 << 20 }).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function freeBytes(dir) {
  let d = dir;
  while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
  try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch (_) { return Infinity; }
}

class MediaSync {
  /** @param master {host, port (app), password}  @param manifestFile where the copies made are listed */
  constructor(master, { mappings = [], manifestFile, log, state, cancelled = () => false }) {
    this.m = master;
    this.mappings = mappings;
    this.manifestFile = manifestFile;
    this.log = log;
    this.state = state;
    this.cancelled = cancelled;
    this.req = null;
    try { this.manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { this.manifest = { files: {} }; }
  }

  _saveManifest() {
    try { fs.mkdirSync(path.dirname(this.manifestFile), { recursive: true }); fs.writeFileSync(this.manifestFile, JSON.stringify(this.manifest, null, 1)); } catch (_) {}
  }

  _get(pathname, query, { range, toFile, onData, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      if (!this.m.password) return reject(new mc.MasterError(mc.NO_PASSWORD, { kind: 'nopassword' }));
      const sig = auth.sign(this.m.password, pathname + qs);
      const headers = { [auth.HEADER]: sig };   // signs the query too
      if (range) headers.Range = `bytes=${range}-`;
      const req = http.get({ host: this.m.host, port: this.m.port, path: pathname + qs, headers, timeout }, res => {
        // a JSON answer (list, fingerprint, error) is checked: from the master
        // only (master-client.js). A file is checked by its fingerprint.
        if (!toFile || res.statusCode >= 400) {
          const parts = []; res.on('data', c => parts.push(c));
          res.on('end', () => {
            try { resolve(mc.checkAnswer(this.m, sig, res.statusCode, res.headers[auth.RESP_HEADER], Buffer.concat(parts).toString('utf8'))); }
            catch (e) { reject(e); }
          });
          return;
        }
        const append = res.statusCode === 206;
        const out = fs.createWriteStream(toFile, { flags: append ? 'a' : 'w' });
        res.on('data', c => onData && onData(c.length));
        // a cut transfer closes its file (no handle left open)
        const fail = e => { out.destroy(); reject(e); };
        res.pipe(out);
        out.on('finish', () => resolve({ append }));
        out.on('error', fail);
        res.on('aborted', () => fail(new Error('transfer cut')));
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('the master does not answer')));
      req.on('error', reject);
      this.req = req;
    });
  }

  cancel() { if (this.req) this.req.destroy(new Error('Cancelled')); }

  /** Paths whose top folder is missing here and has no folder chosen yet. */
  static unresolvedRoots(files, mappings) {
    const roots = new Map();
    for (const f of files) {
      if (f.missing || C.mappingFor(f.path, mappings)) continue;
      if (!rootExists(f.path)) roots.set(C.mediaRoot(f.path).toLowerCase(), C.mediaRoot(f.path));
    }
    return [...roots.values()];
  }

  async run() {
    const st = this.state;
    const list = await this._get('/api/media/list');
    const files = list.files || [];
    st.master_missing = files.filter(f => f.missing).map(f => f.path);

    const roots = MediaSync.unresolvedRoots(files, this.mappings);
    if (roots.length) { st.need_folders = roots; return { need_folders: roots }; }

    // what is already here
    const todo = [];
    for (const f of files) {
      if (f.missing) continue;
      const local = C.mapPath(f.path, this.mappings);
      const bad = unsafeTarget(f.path) || unsafeTarget(local);
      // a file of OBS's own install (Program Files) already here: nothing to do
      if (bad === 'system folder' && fs.existsSync(local)) { st.system_kept = (st.system_kept || 0) + 1; continue; }
      if (bad) {
        st.errors.push(`${f.path}: refused (${bad})`);
        this.log.warn(`Media sync: refused ${f.path} -> ${local} (${bad})`);
        continue;
      }
      let same = false;
      try { const l = fs.statSync(local); same = l.size === f.size && Math.abs(l.mtimeMs - f.mtime) <= SAME_TIME_MS; } catch (_) {}
      if (same) {
        // "copied": put here by a Sync (only those are ever archived; a file
        // that was already here, copied by hand, is left alone)
        const was = this.manifest.files[local];
        this.manifest.files[local] = { master: f.path, size: f.size, mtime: f.mtime, copied: !!(was && was.copied) };
      }
      else if (this._moveEarlierCopy(f, local)) { st.moved = (st.moved || 0) + 1; }
      else todo.push({ ...f, local });
    }
    st.files_total = todo.length;
    st.bytes_total = todo.reduce((a, f) => a + f.size, 0);
    st.up_to_date = files.length - st.master_missing.length - todo.length - (st.moved || 0) - st.errors.length;

    // room on each drive
    const need = new Map();
    for (const f of todo) {
      const k = volumeKey(f.local);
      need.set(k, { dir: path.dirname(f.local), bytes: ((need.get(k) || {}).bytes || 0) + f.size });
    }
    for (const { dir, bytes } of need.values()) {
      const free = freeBytes(dir);
      if (free < bytes) throw new Error(`not enough space for ${dir}: ${(bytes / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free`);
    }

    const when = stamp();
    st.phase = 'copy';
    const t0 = Date.now();
    // speed and time left: only the bytes really fetched now count (a part
    // fetched by an earlier, cut Sync arrives at once and would fake a high
    // speed). The time spent checking the copies is in, so the estimate
    // includes it.
    let fetched = 0, dropped = 0;
    const estimate = () => {
      const s = (Date.now() - t0) / 1000;
      st.speed = s > 1 ? fetched / s : 0;
      const left = Math.max(0, st.bytes_total - st.bytes_done - dropped);
      st.eta_s = s >= 3 && st.speed > 0 ? Math.round(left / st.speed) : null;
    };
    for (const f of todo) {
      if (this.cancelled()) throw new Error('Cancelled');
      st.current = path.basename(f.local);
      let fileDone = 0;
      try {
        await this._copyOne(f, when, (n, resumed) => {
          st.bytes_done += n; fileDone += n;
          if (!resumed) fetched += n;
          estimate();
        });
        st.copied += 1;
      } catch (e) {
        // what this file still had to fetch won't be: out of the time left
        dropped += Math.max(0, f.size - fileDone);
        estimate();
        if (e.message === 'Cancelled' || this.cancelled()) throw new Error('Cancelled');
        const denied = e.code === 'EPERM' || e.code === 'EACCES';
        // a file OBS is playing here can't be replaced: next Sync. A folder
        // this PC's user can't write to is not "in use": say so.
        if (e.code === 'EBUSY' || (denied && !e.noWrite && fs.existsSync(f.local))) st.busy.push(f.local);
        else if (denied) st.errors.push(`${f.local}: no write access here (Settings > Media location: custom, choose another folder)`);
        else st.errors.push(`${f.local}: ${e.message}`);
        this.log.warn(`Media sync: ${f.local}: ${e.message}`);
      }
      st.files_done += 1;
      this._saveManifest();
    }

    // copies made earlier that the master no longer uses: to the archive.
    // Not when the master opened another scene collection (maybe for a
    // moment): its media would all go to the archive, then come back.
    const used = new Set(files.map(f => C.mapPath(f.path, this.mappings).toLowerCase()));
    const sameCollection = !this.manifest.collection || this.manifest.collection === list.name;
    for (const [local, info] of Object.entries(this.manifest.files)) {
      if (used.has(local.toLowerCase()) || !sameCollection) continue;
      try {
        const l = fs.statSync(local);
        if (info.copied && l.size === info.size) { this._archive(local, when); st.archived += 1; }
      } catch (_) {}
      delete this.manifest.files[local];
    }
    if (list.name) this.manifest.collection = list.name;
    this._saveManifest();
    st.current = null;
    return {};
  }

  /** The destination folder changed since the last Sync: the copy made at
   *  the old place is moved (no new download), if it is still intact. */
  _moveEarlierCopy(f, local) {
    for (const [old, info] of Object.entries(this.manifest.files)) {
      // only a copy Sync made itself: a file put there by hand stays where it is
      if (!info.copied || info.master !== f.path || old.toLowerCase() === local.toLowerCase()) continue;
      try {
        const l = fs.statSync(old);
        if (l.size !== f.size || Math.abs(l.mtimeMs - f.mtime) > SAME_TIME_MS || fs.existsSync(local)) continue;
        fs.mkdirSync(path.dirname(local), { recursive: true });
        try { fs.renameSync(old, local); }
        catch (e) {
          if (e.code !== 'EXDEV') throw e;          // another drive: copy, then remove our old copy
          fs.copyFileSync(old, local); fs.utimesSync(local, new Date(), new Date(f.mtime)); fs.unlinkSync(old);
        }
        delete this.manifest.files[old];
        this.manifest.files[local] = { master: f.path, size: f.size, mtime: f.mtime, copied: true };
        this.log.info(`Media sync: moved ${old} -> ${local}`);
        return true;
      } catch (e) { this.log.warn(`Media sync: could not move ${old}: ${e.message}`); }
    }
    return false;
  }

  /** The master folders of the scenes' media, for the Settings panel:
   *  [{root, files, bytes, missing_here (drive absent)}]. */
  async roots() {
    const list = await this._get('/api/media/list');
    const by = new Map();
    for (const f of list.files || []) {
      if (f.missing) continue;
      const r = C.mediaRoot(f.path), k = r.toLowerCase();
      const e = by.get(k) || { root: r, files: 0, bytes: 0, missing_here: !rootExists(f.path) };
      e.files += 1; e.bytes += f.size; by.set(k, e);
    }
    return [...by.values()];
  }

  _archive(local, when) {
    const dest = archivePathFor(local, when, this.mappings);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(local, dest);
  }

  async _copyOne(f, when, onData) {
    try { fs.mkdirSync(path.dirname(f.local), { recursive: true }); }
    catch (e) { e.noWrite = true; throw e; }
    const part = f.local + PART;
    for (let attempt = 1; ; attempt++) {
      let have = 0;
      try { have = fs.statSync(part).size; } catch (_) {}
      if (have > f.size) { fs.rmSync(part, { force: true }); have = 0; }
      if (have) onData(have, true);   // already fetched before: counts as done, not in the speed
      if (have < f.size || f.size === 0) {
        const r = await this._get('/api/media/file', { path: f.path }, { range: have || null, toFile: part, onData });
        if (have && !r.append) { /* the master sent the whole file again: fine */ }
      }
      this.state.phase = 'verify';
      const [want, got] = await Promise.all([
        // the master may have to read a big file first (resumed copy): no short timeout
        this._get('/api/media/hash', { path: f.path }, { timeout: 15 * 60 * 1000 }).then(j => j.hash),
        sha256File(part),
      ]);
      this.state.phase = 'copy';
      if (want === got) break;
      fs.rmSync(part, { force: true });
      this.log.warn(`Media sync: ${f.local} differs from the master, fetched again`);
      if (attempt >= 2) throw new Error('the copy differs from the master twice');
    }
    if (fs.existsSync(f.local)) { this._archive(f.local, when); this.state.archived += 1; }
    fs.renameSync(part, f.local);
    fs.utimesSync(f.local, new Date(), new Date(f.mtime));
    this.manifest.files[f.local] = { master: f.path, size: f.size, mtime: f.mtime, copied: true };
  }
}

module.exports = { MediaSync, archivePathFor, archiveRootFor, rootExists, unsafeTarget, volumeKey, PART };
