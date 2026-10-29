'use strict';
/*
 * OBS Conductor: builds the Windows installer ON WINDOWS.
 * Started by build_windows.bat (which first brings the exact Node.js
 * runtime, checked against nodejs.org's fingerprint, and runs this script
 * with it). Not meant to be run on its own.
 *
 * Same result as build_windows.command on a Mac:
 *   dist\OBSConductor-Setup-X.Y.Z.exe
 * How: the Node.js runtime renamed OBSConductor.exe (nothing is compiled)
 * + the app's code, packed by NSIS (installer\OBSConductor.nsi).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NODE_DIR = path.dirname(process.execPath);          // the runtime the .bat brought
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const say = m => console.log(`\n${m}`);
const fail = m => { console.error(`\n[ERROR] ${m}`); process.exit(1); };
const ask = q => {
  process.stdout.write(`${q} [y/N] `);
  const buf = Buffer.alloc(64); let n = 0;
  try { n = fs.readSync(0, buf, 0, 64, null); } catch (_) {}
  return /^y/i.test(buf.toString('utf8', 0, n).trim());
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });
const npmCli = [path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
                path.join(NODE_DIR, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(p => fs.existsSync(p));
if (!npmCli) fail('npm not found next to the Node.js runtime');
const env = { ...process.env, PATH: NODE_DIR + path.delimiter + (process.env.PATH || '') };
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], { cwd, env });

say(`=== OBS Conductor ${VERSION} - Windows build (on Windows) ===`);

// ---- 1. NSIS ---------------------------------------------------------------
function findMakensis() {
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.split(/\r?\n/)[0].trim();
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
    if (!base) continue;
    const p = path.join(base, 'NSIS', 'makensis.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
let makensis = findMakensis();
if (!makensis) {
  if (process.platform !== 'win32') fail('makensis is missing (install NSIS)');
  if (!ask('NSIS (installer maker) is missing. Install it now with winget?')) fail('stopped: NSIS is needed');
  const r = run('winget', ['install', '-e', '--id', 'NSIS.NSIS', '--accept-source-agreements', '--accept-package-agreements']);
  if (r.error || r.status !== 0) fail('winget could not install NSIS: install it from https://nsis.sourceforge.io/Download then run this again');
  makensis = findMakensis() || fail('NSIS was installed but not found: close this window and run the build again');
}
console.log(`NSIS: ${makensis}`);

// ---- 2. tests --------------------------------------------------------------
say('Tests');
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
const logf = path.join(ROOT, 'build', 'tests.log');
let r = spawnSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ROOT, env, encoding: 'utf8' });
let out = (r.stdout || '') + (r.stderr || '');
if (r.status === 0) {
  r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, env, encoding: 'utf8' });
  out += (r.stdout || '') + (r.stderr || '');
}
fs.writeFileSync(logf, out);
if (r.status !== 0) {
  console.error(out.split(/\r?\n/).filter(l => /^not ok|^# (fail|pass)|Error/.test(l)).slice(0, 40).join('\n'));
  fail('some tests failed (or npm could not install): nothing was built (all of it: build\\tests.log)');
}
console.log(out.split(/\r?\n/).filter(l => /^# (pass|fail)/.test(l)).join('\n'));

// ---- 3. app folder: node.exe renamed + launchers + sources -------------------
// OBSConductor.exe is Node.js itself, renamed: the name tells paths.js it runs
// installed (settings in %LOCALAPPDATA%), and Node.js's own signature stays.
say('Putting the app together');
const WORK = path.join(ROOT, 'build', 'win');
const OUT = path.join(WORK, 'OBSConductor');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(process.execPath, path.join(OUT, 'OBSConductor.exe'));
const lic = path.join(NODE_DIR, 'LICENSE');
if (!fs.existsSync(lic)) fail('the Node.js LICENSE file is missing next to node.exe');
fs.copyFileSync(lic, path.join(OUT, 'NODE-LICENSE.txt'));
// Windows' own line endings for its scripts
for (const f of ['OBSConductor.vbs', 'OBSConductor.cmd']) {
  const txt = fs.readFileSync(path.join(ROOT, 'installer', f), 'utf8').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(OUT, f), txt);
}
// config/ becomes the first settings of every install: after a run from the
// sources it may hold this PC's role, addresses and passwords (review 2.2.2)
{
  const t = fs.readFileSync(path.join(ROOT, 'config', 'settings.yaml'), 'utf8').split(/\r?\n/);
  const bad = t.filter(l => /^ *(role|master_host|host|user|master_obs_password|password): *"[^"]+"/.test(l) &&
    !/^ *host: *"localhost"/.test(l) && !/password: *"YOUR_WEBSOCKET_PASSWORD"/.test(l));
  if (t.some(l => /^ *obs_hooked: *true/.test(l))) bad.push('obs_hooked: true');
  if (bad.length) fail(`config\\settings.yaml is not the clean template (a run from the sources wrote into it): ${bad.join(' | ')}\nPut back the one from the ZIP, then build again.`);
}
const APP = path.join(OUT, 'app');
fs.mkdirSync(APP, { recursive: true });
const keep = src => !/(^|[\\/])\.DS_Store$/.test(src);
fs.cpSync(path.join(ROOT, 'src'), path.join(APP, 'src'), { recursive: true, filter: keep });
fs.cpSync(path.join(ROOT, 'config'), path.join(APP, 'config_template'), { recursive: true, filter: keep });
for (const f of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_LICENSES.md']) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
if (npm(['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], APP).status !== 0) fail('npm install failed');
fs.rmSync(path.join(APP, 'package-lock.json'), { force: true });

// ---- 4. installer ----------------------------------------------------------
say('Installer');
fs.mkdirSync(DIST, { recursive: true });
const SETUP = path.join(DIST, `OBSConductor-Setup-${VERSION}.exe`);
fs.rmSync(SETUP, { force: true });
r = run(makensis, ['-V2', `-DVERSION=${VERSION}`, `-DSRCDIR=${OUT}`, `-DOUTFILE=${SETUP}`, path.join(ROOT, 'installer', 'OBSConductor.nsi')]);
if (r.status !== 0 || !fs.existsSync(SETUP)) fail('NSIS could not build the installer - see above');

say('=== Done ===');
console.log(SETUP);
console.log('Double-click it to install (not signed: SmartScreen says "Windows protected your PC" the first time -> More info -> Run anyway).');
if (process.platform === 'win32') spawnSync('explorer', ['/select,', SETUP]);
