'use strict';
/*
 * Icon in the Windows notification area (+ notifications) and in the macOS
 * menu bar.
 *
 * Node.js can't draw a tray icon by itself, so a small helper does it,
 * started hidden by the app and stopped with it. It polls GET /api/tray
 * (localhost only) for what to show; "Quit" calls POST /api/app/quit.
 *   Windows  tray.ps1, a PowerShell script (WinForms, built into Windows)
 *   macOS    OBSConductorMenu, a small program built by build_mac.command
 *            (installer/mac/menubar.m), next to Node.js in the .app
 *   Linux    nothing: the dock in OBS says it all
 *
 * Notes is the list of notifications waiting for the tray (Windows only).
 * If the helper is blocked or missing, there is simply no icon: the app
 * works the same.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_RESTARTS = 3;

class Notes {
  constructor() { this.seq = 0; this.list = []; }
  add(title, text, icon = 'info') {
    // Windows refuses a notification without text
    if (!text) { text = title; title = 'OBS Conductor'; }
    this.list.push({ seq: ++this.seq, at: Date.now(), title, text, icon });
    if (this.list.length > 20) this.list.shift();
  }
  /** Notifications after `seq`, at most a minute old (a restarted tray must
   *  not replay a pile of old ones). */
  since(seq) {
    const now = Date.now();
    return this.list.filter(n => n.seq > seq && now - n.at < 60000);
  }
}

/** What to start for the tray icon on this system: [program, args], or null
 *  when there is none (Linux, or macOS without the helper: run from sources). */
function command({ platform = process.platform, env = process.env, execPath = process.execPath,
                   port, pid = process.pid, logFile = '', exists = fs.existsSync }) {
  if (platform === 'win32') {
    const ps = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return [ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', path.join(__dirname, 'tray.ps1'),
      '-Port', String(port), '-ParentPid', String(pid),
      '-IconDir', path.join(__dirname, 'icons'), '-LogFile', logFile]];
  }
  if (platform === 'darwin') {
    const helper = path.join(path.dirname(execPath), 'OBSConductorMenu');   // Contents/MacOS, next to node
    if (!exists(helper)) return null;
    return [helper, ['--port', String(port), '--parent-pid', String(pid), '--log-file', logFile]];
  }
  return null;
}

class Tray {
  constructor({ port, log, logFile }) {
    this.port = port; this.log = log; this.logFile = logFile || '';
    this.child = null; this.restarts = 0; this.stopping = false;
  }

  start() {
    if (process.env.OBSCONDUCTOR_NO_TRAY) return;
    const c = command({ port: this.port, logFile: this.logFile });
    if (!c) {
      // macOS, installed app, but no menu bar program next to Node.js: say so
      if (process.platform === 'darwin' && process.env.OBSCONDUCTOR_PACKAGED === '1') this.log.warn('No menu bar icon: OBSConductorMenu is missing from the app (see the build: "Menu bar icon")');
      return;
    }
    let errText = '';
    try {
      // its error messages (if it fails) go into the log
      this.child = spawn(c[0], c[1], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this.log.warn(`No tray icon: ${e.message}`);
      return;
    }
    if (this.child.stderr) this.child.stderr.on('data', d => { if (errText.length < 2000) errText += d; });
    if (process.platform === 'darwin') this.log.info(`Menu bar icon started (${c[0]}, pid ${this.child.pid})`);
    this.child.on('error', e => this.log.warn(`No tray icon: ${e.message}`));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      const why = `code ${code}${signal ? ', ' + signal : ''}${errText.trim() ? ': ' + errText.trim().split('\n').slice(-3).join(' | ') : ''}`;
      errText = '';
      if (++this.restarts > MAX_RESTARTS) { this.log.warn(`Tray icon stopped (${why}) - not restarted`); return; }
      this.log.warn(`Tray icon stopped (${why}) - restarting it`);
      setTimeout(() => this.start(), 5000);
    });
  }

  stop() {
    this.stopping = true;
    if (this.child) try { this.child.kill(); } catch (_) {}
  }
}

module.exports = { Tray, Notes, command };
