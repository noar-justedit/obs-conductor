'use strict';
// Windows / macOS / Linux: where things live, media roots, refused paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const paths = require('../src/paths');
const obsSetup = require('../src/obs-setup');
const C = require('../src/collection');
const { unsafeTarget } = require('../src/media-sync');
const { filterPairs } = require('../src/dialogs');

test('settings folder of the installed app, per system', () => {
  assert.equal(paths.systemDataDir('darwin', {}, '/Users/n'), '/Users/n/Library/Application Support/OBSConductor');
  assert.equal(paths.systemDataDir('linux', {}, '/home/n'), '/home/n/.config/obs-conductor');
  assert.equal(paths.systemDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/n'), '/x/obs-conductor');
  assert.equal(paths.systemDataDir('win32', { LOCALAPPDATA: 'L' }, 'H'), path.join('L', 'OBSConductor'));
});

test("OBS's settings folder, per system (Flatpak when it is the only one)", () => {
  assert.equal(obsSetup.systemObsDir('darwin', {}, '/Users/n'), '/Users/n/Library/Application Support/obs-studio');
  assert.equal(obsSetup.systemObsDir('linux', {}, '/home/n', () => false), '/home/n/.config/obs-studio');
  const flat = '/home/n/.var/app/com.obsproject.Studio/config/obs-studio';
  assert.equal(obsSetup.systemObsDir('linux', {}, '/home/n', p => p === flat), flat);
  assert.equal(obsSetup.systemObsDir('linux', {}, '/home/n', () => true), '/home/n/.config/obs-studio');   // both: the native one
});

test('media root: the disk or the user folder on macOS / Linux', () => {
  assert.equal(C.mediaRoot('/Volumes/SSD/Show/a.mov'), '/Volumes/SSD');
  assert.equal(C.mediaRoot('/Users/noar/Movies/a.mov'), '/Users/noar');
  assert.equal(C.mediaRoot('/home/noar/Videos/a.mov'), '/home/noar');
  assert.equal(C.mediaRoot('/media/noar/SSD/a.mov'), '/media/noar/SSD');
  assert.equal(C.mediaRoot('/run/media/noar/SSD/x/a.mov'), '/run/media/noar/SSD');
  assert.equal(C.mediaRoot('/data/x/a.mov'), '/data');
  assert.equal(C.mediaRoot('D:\\Media\\a.mov'), 'D:\\Media');
});

test('media sync refuses macOS / Linux programs and system folders', () => {
  assert.ok(unsafeTarget('/Users/n/Library/LaunchAgents/x.mov'));
  assert.ok(unsafeTarget('/home/n/.config/autostart/x.mov'));
  assert.ok(unsafeTarget('/home/n/clip.sh'));
  assert.ok(unsafeTarget('/Volumes/SSD/tool.command'));
  assert.ok(unsafeTarget('/usr/local/x.mov'));
  assert.equal(unsafeTarget('/Volumes/SSD/Show/a.mov'), null);
  assert.equal(unsafeTarget('/home/n/Videos/a.mov'), null);
});

test('file dialog filters, read for zenity / kdialog', () => {
  assert.deepEqual(filterPairs('Playlist (*.obsplaylist)|*.obsplaylist|All files|*.*'),
    [['Playlist (*.obsplaylist)', ['*.obsplaylist']], ['All files', ['*']]]);
});

test('tray icon helper: PowerShell on Windows, the menu bar program on macOS, none on Linux', () => {
  const { command } = require('../src/tray');
  const w = command({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, port: 8090, pid: 42, logFile: 'L' });
  assert.match(w[0], /powershell\.exe$/i);
  assert.ok(w[1].includes('-ParentPid') && w[1].includes('42'));
  const mac = '/Applications/OBS Conductor.app/Contents/MacOS/node';
  const m = command({ platform: 'darwin', execPath: mac, port: 8091, pid: 7, logFile: '/l.log', exists: () => true });
  assert.equal(m[0], '/Applications/OBS Conductor.app/Contents/MacOS/OBSConductorMenu');
  assert.deepEqual(m[1], ['--port', '8091', '--parent-pid', '7', '--log-file', '/l.log']);
  assert.equal(command({ platform: 'darwin', execPath: mac, port: 8090, exists: () => false }), null);   // run from the sources
  assert.equal(command({ platform: 'linux', port: 8090 }), null);
});
