'use strict';
/*
 * Where config and playlists live.
 *
 * Development (`node src/main.js`): dev-data/ next to the sources, seeded from
 * config/ (2.3.0: config/ stays the clean template of every install, a run
 * from the sources never writes its role or passwords into it).
 * Installed: the program folder is read-only, so config lives in the user's
 * own folder, seeded on first run from the templates the build put in
 * <app>/config_template:
 *   Windows  %LOCALAPPDATA%\OBSConductor          (OBSConductor.exe = node.exe renamed)
 *   macOS    ~/Library/Application Support/OBSConductor   (OBS Conductor.app)
 *   Linux    $XDG_CONFIG_HOME/obs-conductor, i.e. ~/.config/obs-conductor (.deb, AppImage)
 * The macOS and Linux launchers say "installed" with OBSCONDUCTOR_PACKAGED=1.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_NAME = 'OBSConductor';
// earlier names, newest first: OBS Playlist (1.0.1 - 1.2.x), OBS Scheduler
const OLD_APP_NAMES = ['OBSPlaylist', 'OBSScheduler'];
const ROOT = path.resolve(__dirname, '..');

const isPackaged = () => process.env.OBSCONDUCTOR_PACKAGED === '1' ||
  path.basename(process.execPath).toLowerCase() === 'obsconductor.exe';

/** The folder holding the user's own data, by system (see header). */
function systemDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obs-conductor');
}

function userDataDir() {
  // tests / screenshots: a throw-away folder instead of the project's config/
  if (process.env.OBSCONDUCTOR_DATA_DIR) { fs.mkdirSync(process.env.OBSCONDUCTOR_DATA_DIR, { recursive: true }); return process.env.OBSCONDUCTOR_DATA_DIR; }
  if (!isPackaged()) { const d = path.join(ROOT, 'dev-data'); fs.mkdirSync(d, { recursive: true }); return d; }
  const d = systemDataDir();
  // Windows, first run after a rename: the settings and playlists of the app
  // under its former name are copied over (the old folder is left untouched).
  if (process.platform === 'win32' && !fs.existsSync(d)) {
    const base = path.dirname(d);
    const old = OLD_APP_NAMES.map(n => path.join(base, n)).find(o => fs.existsSync(path.join(o, 'config')));
    if (old) try { fs.cpSync(old, d, { recursive: true }); } catch (_) {}
  }
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const settingsPath = () => path.join(userDataDir(), 'config', 'settings.yaml');
const playlistsDir = () => path.join(userDataDir(), 'config', 'playlists');

/** First run (installed copy, or from the sources): copy the templates. Never overwrites. */
function ensureDefaultConfig() {
  const settings = settingsPath();
  fs.mkdirSync(playlistsDir(), { recursive: true });
  const tpl = path.join(ROOT, isPackaged() ? 'config_template' : 'config');
  const first = !fs.existsSync(settings);
  if (first && fs.existsSync(path.join(tpl, 'settings.yaml'))) {
    fs.copyFileSync(path.join(tpl, 'settings.yaml'), settings);
  }
  // template playlists: first run only (one the user deleted stays deleted)
  const tplPl = path.join(tpl, 'playlists');
  if (first && fs.existsSync(tplPl)) {
    for (const f of fs.readdirSync(tplPl)) {
      const dest = path.join(playlistsDir(), f);
      if (f.endsWith('.yaml') && !fs.existsSync(dest)) fs.copyFileSync(path.join(tplPl, f), dest);
    }
  }
}

module.exports = { APP_NAME, ROOT, isPackaged, systemDataDir, userDataDir, settingsPath, playlistsDir, ensureDefaultConfig };
