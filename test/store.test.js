'use strict';
// Playlist files (.obsplaylist): save then load gives the same playlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

test('save to a file and load it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsp-store-'));
  const st = new Store(path.join(dir, 'playlists'), path.join(dir, 'settings.yaml'));
  st.savePlaylist('Show', { end_action: 'loop', items: [
    { scene: 'Intro', duration: 12.48, video_ref: 'Intro clip' },
    { scene: 'Cam', duration: 8, transition: { name: 'Swipe', duration_ms: 800 } },
  ] });
  const text = st.exportText('Show');
  assert.match(text, /^# OBS Conductor/);
  const name = st.importText(text, 'whatever');
  assert.equal(name, 'Show 2');                         // never overwrites
  const a = st.loadPlaylist('Show'), b = st.loadPlaylist(name);
  assert.deepEqual(b.items.map(i => [i.scene, i.duration, i.transition, i.video_ref]),
                   a.items.map(i => [i.scene, i.duration, i.transition, i.video_ref]));
  assert.equal(b.loop, true);
  assert.ok(b.items.every((it, i) => it.id !== a.items[i].id));   // fresh ids
  assert.throws(() => st.importText('hello: world', 'x'), /no scene list/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('role: not chosen, chosen, and files from before 1.2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsp-role-'));
  const file = path.join(dir, 'settings.yaml');
  const st = new Store(path.join(dir, 'playlists'), file);
  assert.equal(st.role(), '');                          // the dock asks
  st.setRole('slave');
  assert.equal(st.role(), 'slave');
  assert.equal(st.slaveConfig().enabled, true);
  assert.throws(() => st.setRole('boss'));
  fs.writeFileSync(file, 'slave:\n  enabled: true\n  master_host: "10.0.0.5"\n  path_mappings: []\n');
  assert.equal(st.role(), 'slave');                     // 1.1 file
  assert.equal(st.slaveConfig().master_host, '10.0.0.5');
  assert.ok(!('path_mappings' in st.slaveConfig()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('default scene duration: setting, export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsp-dd-'));
  const st = new Store(path.join(dir, 'playlists'), path.join(dir, 'settings.yaml'));
  assert.equal(st.defaultDuration(), 10);
  st.setGeneralSettings({ default_duration: '7.5' });
  assert.equal(st.generalSettings().default_duration, 7.5);
  st.setGeneralSettings({ default_duration: 'x' });     // ignored
  assert.equal(st.defaultDuration(), 7.5);
  st.savePlaylist('A', { items: [{ scene: 'S' }] });
  assert.match(st.exportText('A'), /default_duration: 7.5/);
  assert.equal(st.loadPlaylist('A').items[0].duration, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist file for "Save" follows rename and delete; lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsp-file-'));
  const st = new Store(path.join(dir, 'playlists'), path.join(dir, 'settings.yaml'));
  st.savePlaylist('WPC', { items: [] });
  assert.equal(st.playlistFile('WPC'), null);
  st.setPlaylistFile('WPC', 'D:\\Shows\\WPC.obsplaylist');
  st.renamePlaylist('WPC', 'WPC 26');
  assert.equal(st.playlistFile('WPC'), null);
  assert.equal(st.playlistFile('WPC 26'), 'D:\\Shows\\WPC.obsplaylist');
  st.deletePlaylist('WPC 26');
  assert.equal(st.playlistFile('WPC 26'), null);
  assert.equal(st.locked(), false);
  st.setLocked(true); assert.equal(st.locked(), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a settings.yaml that cannot be read is put aside before anything is written', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsc-broken-'));
  const f = path.join(dir, 'settings.yaml');
  fs.writeFileSync(f, 'role: "slave"\nslave:\n  master_host: "10.0.0.5"\n  bad: [unclosed\n');
  const st = new Store(path.join(dir, 'pl'), f);
  st.setLocked(true);
  const aside = fs.readdirSync(dir).filter(n => n.startsWith('settings.yaml.broken-'));
  assert.equal(aside.length, 1);
  assert.match(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), /master_host: "10.0.0.5"/);
});

test('media location: same as master or custom folders (kept while unused)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsp-store-'));
  const st = new Store(path.join(dir, 'playlists'), path.join(dir, 'settings.yaml'));
  assert.equal(st.mediaMode(), 'same');
  st.setMediaMapping('E:\\', 'D:\\Copy');                    // a folder chosen: custom
  assert.equal(st.mediaMode(), 'custom');
  assert.deepEqual(st.mediaMappings(), [{ from: 'E:\\', to: 'D:\\Copy' }]);
  st.setMediaMode('same');                                   // not used, not forgotten
  assert.deepEqual(st.mediaMappings(), []);
  assert.equal(st.savedMediaMappings().length, 1);
  st.setMediaMode('custom');
  assert.equal(st.mediaMappings().length, 1);
  assert.throws(() => st.setMediaMode('other'));
  // settings from 1.6.3 (no mode written): custom when a folder was chosen
  const st2 = new Store(path.join(dir, 'pl2'), path.join(dir, 's2.yaml'));
  st2._set(['slave', 'media_mappings'], [{ from: 'F:\\', to: 'G:\\' }]);
  assert.equal(st2.mediaMode(), 'custom');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('free run: the slave stops following its master, keeps its role; a new role follows again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsp-store-'));
  const st = new Store(path.join(dir, 'playlists'), path.join(dir, 'settings.yaml'));
  st.setRole('slave');
  assert.equal(st.slaveConfig().enabled, true);
  st.setSlaveConfig({ free_run: true });
  assert.equal(st.role(), 'slave');                 // still a slave: the dock keeps its layout
  assert.equal(st.slaveConfig().enabled, false);    // not following
  assert.equal(st.slaveConfig().free_run, true);
  st.setSlaveConfig({ free_run: false });
  assert.equal(st.slaveConfig().enabled, true);
  st.setSlaveConfig({ free_run: true });
  st.setRole('master');
  st.setRole('slave');
  assert.equal(st.slaveConfig().free_run, false);   // back to following
  assert.equal(st.slaveConfig().enabled, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
