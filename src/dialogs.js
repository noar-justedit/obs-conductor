'use strict';
/*
 * "Save as" / "Open" / "Choose a folder" dialogs, opened by the companion app
 * on the desktop (the dock is a web page: it cannot write a file where you
 * want). Without a dialog (simulation, Linux without zenity / kdialog), the
 * dock falls back to its own file picker or a typed path.
 *
 *   Windows  PowerShell + Windows Forms (below)
 *   macOS    AppleScript (osascript): the values travel as arguments, never
 *            inside the script text
 *   Linux    zenity (GNOME, Pop!_OS...), else kdialog (KDE)
 *
 * Windows:
 * Shown through PowerShell + Windows Forms, kept on top of OBS. Values are
 * passed in single-quoted PowerShell strings and the whole script travels
 * base64-encoded, so no file name or title can break the command.
 *
 * PowerShell is started hidden (no console flashing). Windows applies that
 * "hidden" to the FIRST window the process shows: that used to be the
 * dialog itself, invisible, so Save / Load seemed to do nothing (seen in 1.4.0). An
 * invisible helper window now takes that first show, then the dialog opens
 * normally, on top, in front of OBS.
 */

const { execFile } = require('child_process');

const psQuote = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

let lastDir = null;   // the folder of the last file saved or opened

// the dialog's owner: invisible (opacity 0, 1 px, centre of the screen), on
// top; shown once hidden (eats the "start hidden"), then shown for real
const OWNER = [
  "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; FormBorderStyle='None'; Opacity=0; Width=1; Height=1; StartPosition='CenterScreen'}",
  '$owner.Show(); $owner.Hide(); $owner.Show(); $owner.Activate()',
];

/**
 * @param {'save'|'open'} kind
 * @param {{title, filter, fileName, dir}} o  filter like "OBS Conductor|*.obsplaylist"
 * @returns {Promise<string|null>} chosen path, null if cancelled
 */
function fileDialog(kind, o = {}) {
  if (process.platform === 'darwin') return macFile(kind, o);
  if (process.platform !== 'win32') return linuxFile(kind, o);
  const cls = kind === 'save' ? 'SaveFileDialog' : 'OpenFileDialog';
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    ...OWNER,
    `$d = New-Object System.Windows.Forms.${cls}`,
    `$d.Title = ${psQuote(o.title || '')}`,
    `$d.Filter = ${psQuote(o.filter || 'All files|*.*')}`,
    o.fileName ? `$d.FileName = ${psQuote(o.fileName)}` : '',
    (o.dir || lastDir) ? `$d.InitialDirectory = ${psQuote(o.dir || lastDir)}` : '',
    kind === 'save' ? '$d.OverwritePrompt = $true' : '',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }',
    '$owner.Close()',
  ].filter(Boolean).join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { timeout: 10 * 60 * 1000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`file dialog failed (${err.message})`));
        const p = String(stdout || '').trim();
        if (p) lastDir = require('path').dirname(p);
        resolve(p || null);
      });
  });
}

/** Windows "choose a folder" dialog. @returns {Promise<string|null>} */
function folderDialog(title) {
  if (process.platform === 'darwin') return macFolder(title);
  if (process.platform !== 'win32') return linuxFolder(title);
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    ...OWNER,
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = ${psQuote(title || '')}`,
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
    '$owner.Close()',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { timeout: 10 * 60 * 1000, windowsHide: true },
      (err, stdout) => err ? reject(new Error(`folder dialog failed (${err.message})`)) : resolve(String(stdout || '').trim() || null));
  });
}

// ---- macOS -------------------------------------------------------------------

/** Runs AppleScript lines with `argv` as arguments; null when cancelled. */
function osa(lines, argv) {
  const args = [];
  for (const l of ['on run argv', 'tell me to activate', ...lines, 'end run']) args.push('-e', l);
  return new Promise((resolve, reject) => {
    execFile('osascript', [...args, ...argv.map(String)], { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) return /-128|cancel/i.test(String(stderr) + err.message) ? resolve(null) : reject(new Error(`dialog failed (${String(stderr).trim() || err.message})`));
      resolve(String(stdout || '').replace(/\n$/, '') || null);
    });
  });
}

function macFile(kind, o) {
  const dir = o.dir || lastDir;
  const where = dir ? ' default location (POSIX file (item 3 of argv))' : '';
  const line = kind === 'save'
    ? `POSIX path of (choose file name with prompt (item 1 of argv) default name (item 2 of argv)${where})`
    : `POSIX path of (choose file with prompt (item 1 of argv)${where})`;
  return osa([`return ${line}`], [o.title || '', o.fileName || 'untitled', dir || '']).then(p => {
    if (p) lastDir = require('path').dirname(p);
    return p;
  });
}

const macFolder = title => osa(['return POSIX path of (choose folder with prompt (item 1 of argv))'], [title || ''])
  .then(p => p ? p.replace(/(.)\/$/, '$1') : p);

// ---- Linux -------------------------------------------------------------------

const which = cmd => { try { return require('child_process').execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch (_) { return null; } };
let linuxTool;   // 'zenity' | 'kdialog' | null, looked up once
function linuxDialogTool() {
  if (linuxTool === undefined) linuxTool = !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? null : which('zenity') ? 'zenity' : which('kdialog') ? 'kdialog' : null;
  return linuxTool;
}

/** "Name|*.a;*.b|All|*.*" -> [["Name", ["*.a", "*.b"]], ...] */
const filterPairs = f => {
  const parts = String(f || 'All files|*.*').split('|'), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i], parts[i + 1].split(';').map(x => x === '*.*' ? '*' : x)]);
  return out;
};

function runTool(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10 * 60 * 1000 }, (err, stdout) => {
    if (err) return err.code === 1 ? resolve(null) : reject(new Error(`dialog failed (${err.message})`));   // 1: cancelled
    resolve(String(stdout || '').replace(/\n$/, '') || null);
  }));
}

function linuxFile(kind, o) {
  const tool = linuxDialogTool();
  if (!tool) return Promise.reject(new Error('no file dialog on this PC (install zenity)'));
  const path = require('path');
  const dir = o.dir || lastDir;
  const start = o.fileName ? path.join(dir || require('os').homedir(), o.fileName) : (dir ? dir + '/' : '');
  let args;
  if (tool === 'zenity') {
    args = ['--file-selection', `--title=${o.title || ''}`];
    if (kind === 'save') args.push('--save', '--confirm-overwrite');
    if (start) args.push(`--filename=${start}`);
    for (const [name, pats] of filterPairs(o.filter)) args.push(`--file-filter=${name} | ${pats.join(' ')}`);
  } else {
    const pats = filterPairs(o.filter).map(([n, p]) => `${p.join(' ')}|${n}`).join('\n');
    args = [kind === 'save' ? '--getsavefilename' : '--getopenfilename', start || require('os').homedir(), pats, '--title', o.title || ''];
  }
  return runTool(tool, args).then(p => { if (p) lastDir = path.dirname(p); return p; });
}

function linuxFolder(title) {
  const tool = linuxDialogTool();
  if (!tool) return Promise.reject(new Error('no folder dialog on this PC (install zenity)'));
  return runTool(tool, tool === 'zenity' ? ['--file-selection', '--directory', `--title=${title || ''}`]
                                        : ['--getexistingdirectory', require('os').homedir(), '--title', title || '']);
}

/** Can this PC show the dialogs? (else the dock asks for a typed path) */
const available = () => process.platform === 'win32' || process.platform === 'darwin' || !!linuxDialogTool();

module.exports = { fileDialog, folderDialog, available, filterPairs };
