'use strict';
/*
 * Versions master / slave, and updating a slave from its master.
 *
 * The installer keeps a copy of itself next to the app
 * (<app>\update\OBSConductor-Setup.exe). The master hands that copy to its
 * slaves:
 *   GET /api/update/info        {version, installer: {size, sha256} | null}
 *   GET /api/update/installer   the file (signed request, see auth.js)
 *
 * Slave: every 30 s, reads the master's version. When the master is newer
 * and has its installer, the dock shows "Update". The slave then downloads
 * the installer, checks its fingerprint (SHA-256) and starts it, silently,
 * with "/S /UPDATE=1": Windows asks once for the administrator's OK on that PC,
 * the installer stops the app, replaces it and starts it again. OBS may stay
 * open (the dock is already in it).
 *
 * Windows only, between two Windows PCs: a master tells its system
 * ("platform"), a slave on another system (or on macOS / Linux, where the
 * app is a .dmg / .deb / AppImage) shows "install by hand" instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const auth = require('./auth');

const CHECK_EVERY_MS = 30000;
const INSTALL_WAIT_MS = 2 * 60 * 1000;

/** -1, 0, 1 like a sort: "1.10.0" > "1.9.2". */
function compare(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The installer copy kept on this PC (none when run from the sources). */
function installerFile() {
  if (process.env.OBSCONDUCTOR_UPDATE_FILE) return process.env.OBSCONDUCTOR_UPDATE_FILE;
  if (process.platform !== 'win32' || path.basename(process.execPath).toLowerCase() !== 'obsconductor.exe') return null;
  return path.join(path.dirname(process.execPath), 'update', 'OBSConductor-Setup.exe');
}

/** Master side: what /api/update/info answers. Fingerprint kept in memory. */
class InstallerInfo {
  constructor(version, file = installerFile(), platform = process.platform) { this.version = version; this.file = file; this.platform = platform; this.cache = null; }

  async info() {
    let st = null;
    try { if (this.file) st = fs.statSync(this.file); } catch (_) {}
    if (!st || !st.isFile()) return { version: this.version, platform: this.platform, installer: null };
    const key = `${st.size}|${st.mtimeMs}`;
    if (!this.cache || this.cache.key !== key) {
      const h = crypto.createHash('sha256');
      await new Promise((resolve, reject) => fs.createReadStream(this.file).on('data', c => h.update(c)).on('end', resolve).on('error', reject));
      this.cache = { key, size: st.size, sha256: h.digest('hex') };
    }
    return { version: this.version, platform: this.platform, installer: { size: this.cache.size, sha256: this.cache.sha256 } };
  }
}

/** Slave side: the master's version, and the update itself. */
class Updater {
  /**
   * master(): {host, port, password} of the master, or null.
   * opts.launch(file): starts the installer (tests, simulation: replaced).
   */
  constructor(version, master, log, { launch, simulate, platform } = {}) {
    this.version = version;
    this.platform = platform || process.platform;
    this.master = master;
    this.log = log;
    this.simulate = !!simulate;
    this.launch = launch || (file => launchInstaller(file));
    this.remote = null;           // {version, installer, host, at}
    this.job = { phase: 'idle' }; // idle | download | verify | launch | installing | error | done
    this._checkAt = 0;
  }

  /** Reads the master's version (at most every 30 s unless forced). */
  async check(force = false) {
    const m = this.master();
    if (!m || !m.host) { this.remote = null; return null; }
    if (!force && this.remote && this.remote.host === m.host && Date.now() - this._checkAt < CHECK_EVERY_MS) return this.remote;
    if (this._checking) return this.remote;
    this._checking = true;
    this._checkAt = Date.now();
    try {
      let j;
      try { j = await getJson(m, '/api/update/info'); }
      catch (e) {
        if (e.status !== 404) throw e;
        // a master older than 1.3.0: only its version
        const w = await getJson(m, '/api/whoami');
        j = { version: w.version, installer: null };
      }
      // the installer is offered only if the master sealed it with its password
      let inst = j.installer || null;
      if (inst && !auth.sealOk(m.password, auth.updateText(j.version, inst), inst.seal)) inst = null;
      const unsealed = !!j.installer && !inst;
      // masters before 2.0 don't say their system: they were all Windows
      const otherOs = (j.platform || 'win32') !== this.platform;
      if (otherOs || this.platform !== 'win32') inst = null;
      this.remote = { version: j.version || null, installer: inst, host: m.host, at: Date.now(), unsealed: unsealed && !otherOs, other_os: otherOs };
    } catch (_) {
      // master not reachable: keep what we knew
    } finally { this._checking = false; }
    return this.remote;
  }

  snapshot() {
    // the installer stops this app within seconds: still here 2 minutes
    // later, the administrator's OK was refused (or the install failed)
    if (this.job.phase === 'installing' && Date.now() - this.job.at > INSTALL_WAIT_MS) {
      this.job = { phase: 'error', error: 'Not installed (Windows OK refused?). Try again.' };
    }
    const r = this.remote;
    const cmp = r && r.version ? compare(r.version, this.version) : 0;
    return {
      local: this.version,
      master: r ? r.version : null,
      newer: cmp > 0,                       // the master is newer: update this PC
      older: cmp < 0,                       // the master is older: update the master
      available: cmp > 0 && !!(r && r.installer),
      unsealed: !!(r && r.unsealed),         // the master's installer could not be checked
      other_os: !!(r && r.other_os),         // the master runs on another system: its installer doesn't fit
      manual: this.platform !== 'win32',     // macOS / Linux: updates are installed by hand
      job: { ...this.job },
    };
  }

  busy() { return ['download', 'verify', 'launch', 'installing'].includes(this.job.phase); }

  /** Downloads the master's installer, checks it, starts it. */
  async run() {
    if (this.busy()) return;
    // busy at once: a second click (or another dock) can't start a second update
    this.job = { phase: 'download', done: 0, total: 0 };
    const m = this.master();
    await this.check(true);
    const r = this.remote;
    if (!m || !r || !r.installer || compare(r.version, this.version) <= 0) {
      this.job = { phase: 'error', error: r && r.unsealed ? 'The master\'s installer could not be checked (wrong password?): link the master again'
                                                        : 'No newer version on the master' };
      return;
    }
    const file = path.join(os.tmpdir(), `OBSConductor-Setup-${r.version}.exe`);
    try {
      this.job = { phase: 'download', done: 0, total: r.installer.size, version: r.version };
      this.log.info(`Update: downloading v${r.version} from the master`);
      const h = crypto.createHash('sha256');
      await download(m, '/api/update/installer', file, c => { h.update(c); this.job.done += c.length; }, req => { this.req = req; });
      this.job = { ...this.job, phase: 'verify' };
      if (h.digest('hex') !== r.installer.sha256) throw new Error('The file arrived damaged. Try again.');
      this.job = { ...this.job, phase: 'launch' };
      if (this.simulate) {
        this.log.info(`Update (simulation): v${r.version} downloaded and checked, not installed`);
        this.job = { phase: 'done', version: r.version, simulated: true };
        return;
      }
      await this.launch(file);
      this.log.info(`Update: installer v${r.version} started`);
      this.job = { phase: 'installing', version: r.version, at: Date.now() };
    } catch (e) {
      this.log.warn(`Update failed: ${e.message}`);
      this.job = { phase: 'error', error: e.message };
    } finally { this.req = null; }
  }

  cancel() { if (this.req) this.req.destroy(new Error('Cancelled')); }
}

function request(m, pathname, signed) {
  return new Promise((resolve, reject) => {
    const headers = signed ? { [auth.HEADER]: auth.sign(m.password, pathname) } : {};
    const req = http.get({ host: m.host, port: m.port, path: pathname, headers, timeout: 5000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('the master does not answer')));
    req.on('error', reject);
  });
}

async function getJson(m, pathname) {
  const res = await request(m, pathname, false);
  let b = '';
  res.setEncoding('utf8');
  for await (const c of res) b += c;
  if (res.statusCode >= 400) { const e = new Error(`master answered HTTP ${res.statusCode}`); e.status = res.statusCode; throw e; }
  return JSON.parse(b);
}

async function download(m, pathname, file, onChunk, onReq) {
  const res = await new Promise((resolve, reject) => {
    const headers = { [auth.HEADER]: auth.sign(m.password, pathname) };
    const req = http.get({ host: m.host, port: m.port, path: pathname, headers, timeout: 30000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('the master does not answer')));
    req.on('error', reject);
    onReq(req);
  });
  if (res.statusCode === 401) { res.resume(); throw new Error('The master refused the password. Link it again.'); }
  if (res.statusCode >= 400) { res.resume(); throw new Error(`master answered HTTP ${res.statusCode}`); }
  const out = fs.createWriteStream(file);
  await new Promise((resolve, reject) => {
    const fail = e => { out.destroy(); reject(e); };   // the file is closed either way
    res.on('data', onChunk);
    res.on('aborted', () => fail(new Error('Transfer cut')));
    res.on('error', fail);
    out.on('error', fail);
    out.on('finish', resolve);
    res.pipe(out);
  });
}

/**
 * Windows: starts the installer. It asks Windows for the administrator's OK
 * by itself (the NSIS installer requires it), and starts the app again
 * afterwards as the user, not as admin (installer/OBSConductor.nsi).
 */
function launchInstaller(file) {
  return new Promise((resolve, reject) => {
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const cmd = `Start-Process -FilePath ${q(file)} -ArgumentList '/S','/UPDATE=1'`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
    let err = '';
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error('The installer could not start')));
  });
}

module.exports = { compare, installerFile, InstallerInfo, Updater, CHECK_EVERY_MS };
