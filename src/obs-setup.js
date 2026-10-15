'use strict';
/*
 * Hooks OBS Conductor into OBS Studio, with OBS closed. Done by the app
 * itself the first time it runs (main.js, hookObsOnce), and on demand:
 *
 *   <node> app/src/obs-setup.js install     add the dock, turn on OBS's
 *                                           WebSocket server, copy its
 *                                           password here
 *   <node> app/src/obs-setup.js uninstall   remove the dock (Windows
 *                                           uninstaller)
 * (the installed app also takes --add-dock, see main.js)
 *
 * Exit codes: 0 done, 3 OBS is open (close it and retry), 4 OBS was never
 * started by this user (no OBS settings to add the dock to), 1 error.
 *
 * OBS's settings folder (obsDir):
 *   Windows  %APPDATA%\obs-studio
 *   macOS    ~/Library/Application Support/obs-studio
 *   Linux    ~/.config/obs-studio, or the Flatpak's
 *            ~/.var/app/com.obsproject.Studio/config/obs-studio
 *
 * What it changes in OBS (only these keys, the rest of the files is kept):
 * - the custom browser dock list: [BasicWindow] ExtraBrowserDocks in
 *   <obsDir>/user.ini (OBS 31+) or global.ini (older OBS). OBS rewrites
 *   these files when it quits: that's why OBS must be closed.
 * - the WebSocket server switch: plugin_config\obs-websocket\config.json
 *   (or [OBSWebSocket] in global.ini for OBS 28-29). If OBS never set a
 *   password, one is generated.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

const DOCK_TITLE = 'OBS Conductor';
const OLD_DOCK_TITLES = ['OBS Playlist'];   // the app's former names
const isMine = d => d.title === DOCK_TITLE || OLD_DOCK_TITLES.includes(d.title);

/** OBS's settings folder on this system (see header). */
function systemObsDir(platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obs-studio');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obs-studio');
  const native = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obs-studio');
  // OBS installed from Flathub keeps its settings in its own sandbox
  const flatpak = path.join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio');
  return !exists(native) && exists(flatpak) ? flatpak : native;
}

const obsDir = () => process.env.OBS_CONFIG_DIR || systemObsDir();

// How to list OBS's process: Windows obs64.exe, macOS "OBS" (OBS.app),
// Linux "obs" (also inside the Flatpak)
const OBS_PROC = process.platform === 'win32'
  ? ['tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH'], out => /obs64\.exe/i.test(out)]
  : ['pgrep', ['-x', process.platform === 'darwin' ? 'OBS' : 'obs'], out => /\d/.test(out)];

function isObsRunning() {
  // tests: say "OBS open / closed" without depending on the PC running them
  if (process.env.OBSCONDUCTOR_OBS_RUNNING) return process.env.OBSCONDUCTOR_OBS_RUNNING === '1';
  const [cmd, args, found] = OBS_PROC;
  try {
    return found(execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (_) {
    return false;   // pgrep exits with 1 when nothing matches
  }
}

/** Same, without blocking (used by the running app every few seconds).
 *  null: can't tell. */
function isObsRunningAsync() {
  if (process.env.OBSCONDUCTOR_OBS_RUNNING) return Promise.resolve(process.env.OBSCONDUCTOR_OBS_RUNNING === '1');
  const [cmd, args, found] = OBS_PROC;
  return new Promise(resolve => execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, out) => {
    if (!err) return resolve(found(out));
    resolve(process.platform !== 'win32' && err.code === 1 ? false : null);   // pgrep: 1 = not running
  }));
}

// ---- minimal INI editing: only the key we touch changes ---------------------

function iniGet(text, section, key) {
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(.+)\]\s*$/);
    if (m) { cur = m[1]; continue; }
    if (cur === section) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1);
    }
  }
  return null;
}

function iniSet(text, section, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  let cur = null, secEnd = -1, found = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[(.+)\]\s*$/);
    if (m) { cur = m[1]; if (cur === section) secEnd = i + 1; continue; }
    if (cur === section) {
      const j = lines[i].indexOf('=');
      if (j > 0 && lines[i].slice(0, j).trim() === key) { lines[i] = `${key}=${value}`; found = true; break; }
      if (lines[i].trim()) secEnd = i + 1;
    }
  }
  if (!found) {
    if (secEnd >= 0) lines.splice(secEnd, 0, `${key}=${value}`);
    else {
      if (lines.length && lines[lines.length - 1].trim()) lines.push('');
      lines.push(`[${section}]`, `${key}=${value}`);
    }
  }
  return lines.join(eol).replace(/(\r?\n)*$/, eol);
}

const readText = f => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch (_) { return null; } };

/** The OBS file holding the dock list (see header). */
function dockConfigFile() {
  const user = path.join(obsDir(), 'user.ini');
  const global = path.join(obsDir(), 'global.ini');
  if (fs.existsSync(user)) return user;
  if (fs.existsSync(global)) return global;
  return user;   // OBS never started: OBS 31+ reads user.ini
}

function readDocks(text) {
  const raw = iniGet(text, 'BasicWindow', 'ExtraBrowserDocks');
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

function addDock(url) {
  const file = dockConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = readText(file) || '';
  const docks = readDocks(text);
  // ours: by title, the loader page, or the URL of the dock added by hand
  // in 1.1 (port 8090 only: a dock of another local tool is left alone)
  const mine = docks.find(d => isMine(d) || /^http:\/\/(localhost|127\.0\.0\.1):8090\/?$/.test(d.url || '') ||
                              /dock-loader\.html/.test(d.url || ''));
  if (mine) { mine.title = DOCK_TITLE; mine.url = url; }
  else docks.push({ title: DOCK_TITLE, url, uuid: crypto.randomUUID().replace(/-/g, '') });
  fs.writeFileSync(file, iniSet(text, 'BasicWindow', 'ExtraBrowserDocks', JSON.stringify(docks)), 'utf8');
  return { file, added: !mine };
}

function removeDock() {
  let removed = 0;
  for (const f of ['user.ini', 'global.ini'].map(n => path.join(obsDir(), n))) {
    const text = readText(f);
    if (text == null) continue;
    const docks = readDocks(text);
    const keep = docks.filter(d => !isMine(d));
    if (keep.length === docks.length) continue;
    removed += docks.length - keep.length;
    fs.writeFileSync(f, iniSet(text, 'BasicWindow', 'ExtraBrowserDocks', JSON.stringify(keep)), 'utf8');
  }
  return removed;
}

// ---- OBS WebSocket server -------------------------------------------------------

const wsConfigFile = () => path.join(obsDir(), 'plugin_config', 'obs-websocket', 'config.json');

/** {port, password, enabled} as OBS has them, or null if OBS has none yet. */
function readWebsocket() {
  const j = readText(wsConfigFile());
  if (j) {
    try {
      const c = JSON.parse(j);
      return { port: c.server_port || 4455, password: c.auth_required === false ? '' : (c.server_password || ''),
               enabled: !!c.server_enabled };
    } catch (_) {}
  }
  const g = readText(path.join(obsDir(), 'global.ini'));
  if (g && iniGet(g, 'OBSWebSocket', 'ServerPort') != null) {   // OBS 28-29
    return { port: parseInt(iniGet(g, 'OBSWebSocket', 'ServerPort'), 10) || 4455,
             password: iniGet(g, 'OBSWebSocket', 'AuthRequired') === 'false' ? '' : (iniGet(g, 'OBSWebSocket', 'ServerPassword') || ''),
             enabled: iniGet(g, 'OBSWebSocket', 'ServerEnabled') === 'true' };
  }
  return null;
}

/** Turns the server on (keeping OBS's port and password; creating them if
 *  OBS never had any). Returns {port, password}. */
function enableWebsocket() {
  const file = wsConfigFile();
  const j = readText(file);
  if (j) {
    const c = JSON.parse(j);
    c.server_enabled = true;
    if (!c.server_port) c.server_port = 4455;
    if (c.auth_required !== false && !c.server_password) c.server_password = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(file, JSON.stringify(c, null, 4), 'utf8');
    return { port: c.server_port, password: c.auth_required === false ? '' : c.server_password };
  }
  const gFile = path.join(obsDir(), 'global.ini');
  const g = readText(gFile);
  if (g && iniGet(g, 'OBSWebSocket', 'ServerPort') != null) {   // OBS 28-29
    fs.writeFileSync(gFile, iniSet(g, 'OBSWebSocket', 'ServerEnabled', 'true'), 'utf8');
    return readWebsocket();
  }
  // OBS never ran its WebSocket server: the same file OBS would write itself
  const c = { alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true,
              server_password: crypto.randomBytes(12).toString('base64url'), server_port: 4455 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 4), 'utf8');
  return { port: c.server_port, password: c.server_password };
}

// ---- the page the dock opens ---------------------------------------------------

/**
 * Installed: a copy of dock-loader.html in the user's data folder, refreshed
 * at each start (main.js). The dock in OBS points at that copy, which never
 * moves - the app itself may: an AppImage is mounted at a new place each
 * time, a Mac app may be moved out of Downloads. From the sources: the file
 * itself.
 */
function loaderPage() {
  const paths = require('./paths');
  const src = path.join(__dirname, 'dock-loader.html');
  if (!paths.isPackaged()) return src;
  const dest = path.join(paths.userDataDir(), 'dock-loader.html');
  try { if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== fs.readFileSync(src, 'utf8')) fs.copyFileSync(src, dest); }
  catch (_) { return src; }
  return dest;
}

// ---- command line (installer / uninstaller) -----------------------------------

function main(cmd) {
  const paths = require('./paths');
  const { Store } = require('./store');
  // installed copy: <user data>/install.log (from the sources: console only)
  const logFile = paths.isPackaged() ? path.join(paths.userDataDir(), 'install.log') : null;
  const log = m => {
    if (logFile) try { fs.appendFileSync(logFile, `${new Date().toLocaleString('sv-SE')} ${cmd}: ${m}\r\n`); } catch (_) {}
    try { console.log(m); } catch (_) {}   // run hidden: there may be no console at all
  };

  if (isObsRunning()) { log('OBS Studio is open - waiting for it to be closed'); return 3; }
  try {
    if (cmd === 'install') {
      if (!fs.existsSync(obsDir())) { log(`No OBS settings in ${obsDir()} - OBS never started for this user`); return 4; }
      paths.ensureDefaultConfig();
      const store = new Store(paths.playlistsDir(), paths.settingsPath());
      const s = store.settings();
      const port = (s.dashboard && parseInt(s.dashboard.port, 10)) || 8090;
      // the dock opens a local page that hands over to the app, or says it's
      // not running (dock-loader.html) - rather than OBS's error page
      const { pathToFileURL } = require('url');
      const d = addDock(`${pathToFileURL(loaderPage()).href}?port=${port}`);
      log(`Dock ${d.added ? 'added to' : 'updated in'} ${d.file}`);
      const ws = enableWebsocket();
      store.setGeneralSettings({ obs: { host: 'localhost', port: ws.port, password: ws.password } });
      store.setObsHooked(true);
      log(`OBS WebSocket server on (port ${ws.port}), password copied into OBS Conductor settings`);
      return 0;
    }
    if (cmd === 'uninstall') {
      log(`Dock removed from OBS (${removeDock()} found)`);
      return 0;
    }
    console.log('usage: obs-setup.js install | uninstall');
    return 1;
  } catch (e) {
    log(`ERROR: ${e.stack || e.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv[2]));

module.exports = { obsDir, systemObsDir, loaderPage, main, iniGet, iniSet, addDock, removeDock, readWebsocket, enableWebsocket, dockConfigFile, DOCK_TITLE, isObsRunning, isObsRunningAsync };
