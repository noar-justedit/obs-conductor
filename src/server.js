'use strict';
/*
 * Local HTTP server behind the OBS dock.
 *
 * GET /             the dock page (dock.html). In OBS: Docks > Custom Browser
 *                   Docks, URL http://localhost:8090/
 * /api/...          JSON API used by the dock: scenes, transitions, video
 *                   lengths, playlists, play/stop, role, master / slave.
 * /api/whoami       read by the slaves' network scan (no password in it).
 * /api/update/...   this PC's version and installer, for the slaves' Update.
 * /api/tray, /api/app/quit, the OBS password in /api/master_info: only for
 *                   this PC itself (the tray icon, the dock inside OBS).
 *
 * Changes (POST / DELETE) only from this PC; the network can only read
 * (the slaves). See hostAllowed / changeAllowed.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const P = require('./player');
const { Store } = require('./store');
const OBS = require('./obs');
const os = require('os');
const dialogs = require('./dialogs');
const { fileDialog, folderDialog } = dialogs;
const { MediaServer } = require('./media-serve');
const paths = require('./paths');
const discovery = require('./discovery');
const auth = require('./auth');
const C = require('./collection');
const obsSetup = require('./obs-setup');
const obsSettings = require('./obs-settings');
const crypto = require('crypto');
const { FAKE_NETWORK } = require('./fake-obs');
const FILE_FILTER = 'OBS Conductor playlist (*.obsplaylist)|*.obsplaylist|YAML (*.yaml;*.yml)|*.yaml;*.yml|All files|*.*';

/** The request comes from this PC (the dock inside OBS, the tray icon). */
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

const hostOf = req => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];

/**
 * Security (review 1.5.4):
 *  - every request must be addressed to this PC by a name that is its own
 *    (localhost, its IPs, its computer name): a web page using "DNS
 *    rebinding" can't reach the app through a name of its own;
 *  - every change (POST / DELETE) must come from this PC, from the dock
 *    itself (no foreign web page: Origin) and as JSON. The slaves only READ
 *    the master (GET, and signed GETs for private data).
 */
function hostAllowed(req, app) {
  const h = hostOf(req);
  if (!h) return true;                                   // HTTP/1.0 tools: nothing to check
  if (LOOPBACK_NAMES.includes(h) || (app.ips || []).includes(h)) return true;
  // an address this PC got since the app started (DHCP, new network card)
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.address.toLowerCase() === h) return true;
  const pc = os.hostname().toLowerCase();
  return h === pc || h.split('.')[0] === pc;
}
function changeAllowed(req) {
  if (!isLocal(req)) return 'changes are made from this PC only (its dock in OBS)';
  const origin = req.headers.origin;
  if (origin != null) {
    let o; try { o = new URL(origin); } catch (_) { return 'refused (foreign page)'; }
    if (!LOOPBACK_NAMES.includes(o.hostname.replace(/^\[|\]$/g, ''))) return 'refused (foreign page)';
  }
  const len = parseInt(req.headers['content-length'] || '0', 10);
  const type = String(req.headers['content-type'] || '');
  if (len > 0 && !/^application\/json\b/i.test(type)) return 'refused (JSON only)';
  return null;
}

/** OBS's WebSocket settings on this PC: {port, password, enabled}. */
function localWebsocket(app) {
  if (app.simulate) return { port: 4455, password: 'sim-password', enabled: true };
  return obsSetup.readWebsocket() || { port: app.store.obsConfig().port, password: app.store.obsConfig().password, enabled: null };
}

const DOCK = path.join(__dirname, 'dock.html');

/** The scene collection open in this PC's OBS: {name, data}. */
async function masterCollection(app) {
  if (app.simulate && !app.client.fileBacked) { const d = app.client.collectionJson(); return { name: d.name, data: d }; }
  if (app.simulate) app.client._saveCollection();
  const c = await C.currentCollection(app.client);
  if (!c.data) throw new Error(`no file found on disk for the scene collection "${c.name}"`);
  // positions / sizes: OBS's live values (its file may not have them yet)
  return { name: c.name, data: await C.withLiveTransforms(app.client, c.data) };
}

function startServer(app, port, bind) {
  const { store } = app;
  const media = new MediaServer(path.join(paths.userDataDir(), 'media-hashes.json'), app.log);
  // the media the slaves may fetch: those of the open collection (kept 5 s)
  let usedCache = { at: 0, list: null, name: null };
  async function usedMedia() {
    if (Date.now() - usedCache.at > (app.mediaListTtl ?? 5000) || !usedCache.list) {
      const c = await masterCollection(app);
      usedCache = { at: Date.now(), list: C.mediaPaths(c.data), name: c.name };
    }
    return usedCache;
  }
  const signed = (req, url) => auth.verify(req.headers[auth.HEADER], localWebsocket(app).password, url.pathname + url.search);

  const send = (res, code, body, type) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const json = (res, payload, code = 200) => send(res, code, JSON.stringify(payload), 'application/json');

  const readBody = req => new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve(null); } });
  });

  async function get(url, req, res) {
    const q = url.searchParams;
    switch (url.pathname) {
      case '/': case '/dock':
        // read on every request: editing dock.html needs no restart
        return send(res, 200, fs.readFileSync(DOCK, 'utf8'), 'text/html; charset=utf-8');
      case '/favicon.ico': {               // the dock's tab icon (and no 404 at each load)
        const ico = fs.readFileSync(path.join(__dirname, 'icons', 'app.ico'));
        res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'max-age=86400', 'Content-Length': ico.length });
        return res.end(ico);
      }
      case '/fonts/Poppins-Bold.ttf':      // the family logo font (SIL OFL, fonts/Poppins-OFL.txt)
      case '/fonts/Oswald.ttf': {          // the ON AIR sign (SIL OFL, fonts/Oswald-OFL.txt)
        const font = fs.readFileSync(path.join(__dirname, 'fonts', path.basename(url.pathname)));
        res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400', 'Content-Length': font.length });
        return res.end(font);
      }
      case '/api/state':
        return json(res, app.state());
      case '/api/scenes':
        try { return json(res, { scenes: await OBS.listScenes(app.client) }); }
        catch (e) { return json(res, { scenes: [], error: e.message }, 502); }
      case '/api/transitions':
        try { return json(res, await OBS.listTransitions(app.client)); }
        catch (e) { return json(res, { names: [], fixed: [], error: e.message }, 502); }
      case '/api/scene_media': {
        const scene = q.get('scene');
        if (!scene) return json(res, { error: "missing 'scene'" }, 400);
        try {
          const media = await OBS.sceneMedia(app.client, scene);
          const ref = OBS.referenceVideo(media);
          return json(res, { scene, media, duration: ref ? ref.duration : null, reference: ref ? ref.source : null });
        } catch (e) { return json(res, { error: e.message }, 502); }
      }
      case '/api/playlists':
        return json(res, { names: store.listPlaylists(), active: store.activePlaylistName() });
      case '/api/settings':
        return json(res, { ...store.generalSettings(), version: app.version, local_ips: app.ips,
                           simulated: app.simulate });
      case '/api/whoami': {
        // read by the slaves' network scan
        return json(res, { app: 'obs-conductor', version: app.version, name: os.hostname(), role: store.role(),
                           obs_port: localWebsocket(app).port });
      }
      case '/api/master_info': {
        // what the slaves need: this PC's IP, OBS's WebSocket port and password
        // (the password only for the dock on this very PC)
        const ws = localWebsocket(app);
        // the password: only for the dock of this very PC, reached as localhost
        const local = isLocal(req) && LOOPBACK_NAMES.includes(hostOf(req));
        return json(res, { ips: app.ips, name: os.hostname(), port: ws.port, enabled: ws.enabled,
                           auth: !!ws.password, password: local ? ws.password : null, local });
      }
      case '/api/update/info':
        // read by the slaves: this PC's version and its installer copy
        try {
          const info = await app.installer.info();
          // sealed with this PC's OBS password: a fake master or a man in the
          // middle can't offer its own "installer"
          if (info.installer) info.installer.seal = auth.seal(localWebsocket(app).password, auth.updateText(info.version, info.installer));
          return json(res, info);
        }
        catch (e) { return json(res, { version: app.version, installer: null, error: e.message }); }
      case '/api/update/installer': {
        // a slave's "Update": signed with this PC's OBS password
        if (!signed(req, url)) return json(res, { error: 'wrong password' }, 401);
        if (!app.installer.file) return json(res, { error: 'no installer on the master' }, 404);
        return media.serve(req, res, app.installer.file);
      }
      case '/api/tally/devices':
        // Settings > Tally: the switcher models OBS Conductor can read
        return json(res, { devices: require('./tally/index').catalog() });
      case '/api/tally/inputs':
        // Settings > Tally: the switcher's inputs [{id, name}], to pick this OBS's one
        try {
          const r = await app.tally.inputs();
          // the input named like this PC, preselected when none is chosen yet
          return json(res, { ...r, suggest: require('./tally/index').suggestInput(r.inputs, os.hostname()), pc: os.hostname() });
        }
        catch (e) { return json(res, { inputs: [], error: `not reachable: ${e.message}` }, 502); }
      case '/api/tally/scan':
        // Settings > Tally > Scan: the switchers on this PC's network (reads
        // only, on demand: the button), from this PC only
        if (!isLocal(req)) return json(res, { error: 'this PC only' }, 403);
        if (require('./tally/guard').isCut()) return json(res, { error: 'the tally is stopped: turn it on first' }, 409);
        if (app.simulate) { await new Promise(r => setTimeout(r, 1200)); return json(res, { found: require('./tally/index').FAKE_SCAN }); }
        return json(res, { found: await require('./tally/index').scan() });
      case '/api/tally/test':
        // Settings > Tally > Test connection: connects again from scratch and
        // reads (never writes: every message goes through tally/guard.js)
        if (!isLocal(req)) return json(res, { error: 'this PC only' }, 403);
        return json(res, await app.tally.test());
      case '/api/tally/debug':
        // what the switcher answers, raw: to send when the tally looks wrong
        if (!isLocal(req)) return json(res, { error: 'this PC only' }, 403);
        try { return json(res, await app.tally.debug()); }
        catch (e) { return json(res, { error: e.message }, 502); }
      case '/api/tray':
        if (!isLocal(req)) return json(res, { error: 'this PC only' }, 403);
        return json(res, app.trayInfo(parseInt(q.get('since'), 10) || 0));
      case '/api/slave/scan': {
        if (app.simulate) {
          await new Promise(r => setTimeout(r, 1200));
          return json(res, FAKE_NETWORK);
        }
        return json(res, await discovery.scan());
      }
      case '/api/playlist': {
        const name = q.get('name') || store.activePlaylistName();
        const pl = store.loadPlaylist(name);
        const file = store.playlistFile(name);
        pl.default_transition = store.defaultTransition();   // general settings
        pl.default_duration = store.defaultDuration();
        return json(res, { name, playlist: pl, rev: store.revision(name), total: P.totalDuration(pl), file });
      }
      case '/api/playlist/download': {
        // fallback when no system dialog is available (simulation, browser)
        const name = q.get('name') || store.activePlaylistName();
        const body = store.exportText(name);
        res.writeHead(200, {
          'Content-Type': 'application/x-yaml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.obsplaylist"`,
          'Content-Length': Buffer.byteLength(body),
        });
        return res.end(body);
      }
      case '/api/scenes/collection': {
        // read by a slave's "Sync": signed with this PC's OBS password
        if (!signed(req, url)) return json(res, { error: 'wrong password' }, 401);
        try {
          const c = await masterCollection(app);
          return json(res, { name: c.name, collection: c.data });
        } catch (e) { return json(res, { error: e.message }, 502); }
      }
      case '/api/scenes/fingerprint': {
        // a slave with "Auto sync": has anything changed since its last Sync?
        if (!signed(req, url)) return json(res, { error: 'wrong password' }, 401);
        try {
          const c = await masterCollection(app);
          let fp = C.fingerprint(c.data, media.list(C.mediaPaths(c.data)));
          // the general OBS settings count too (Sync copies them)
          try { fp = crypto.createHash('sha256').update(fp + JSON.stringify(await obsSettings.read(app.client))).digest('hex'); } catch (_) {}
          return json(res, { fingerprint: fp });
        } catch (e) { return json(res, { error: e.message }, 502); }
      }
      case '/api/obs/settings': {
        // a slave's "Sync": this PC's canvas, FPS, colour and audio settings
        if (!signed(req, url)) return json(res, { error: 'wrong password' }, 401);
        try { return json(res, await obsSettings.read(app.client)); }
        catch (e) { return json(res, { error: e.message }, 502); }
      }
      case '/api/media/list':
      case '/api/media/hash':
      case '/api/media/file': {
        // a slave's "Sync": the media of this PC's scenes, signed requests only
        if (!signed(req, url)) return json(res, { error: 'wrong password' }, 401);
        let used;
        try { used = await usedMedia(); } catch (e) { return json(res, { error: e.message }, 502); }
        if (url.pathname === '/api/media/list') return json(res, { name: used.name, files: media.list(used.list) });
        const p = q.get('path');
        if (!used.list.includes(p)) return json(res, { error: 'not a media of the scenes' }, 403);
        if (url.pathname === '/api/media/file') return media.serve(req, res, p);
        try { return json(res, { hash: await media.hash(p) }); } catch (e) { return json(res, { error: e.message }, 404); }
      }
      case '/api/slave/sync_scenes':
        return json(res, app.sceneSync.snapshot());
      case '/api/slave/media_roots': {
        // Settings: the master's media folders and where each goes here
        const c = store.slaveConfig();
        if (store.role() !== 'slave' || !c.master_host) return json(res, { roots: [], error: 'no master' }, 400);
        const { MediaSync } = require('./media-sync');
        try {
          const job = new MediaSync({ host: c.master_host, port: c.master_dashboard_port || 8090, password: c.master_obs_password },
            { manifestFile: path.join(paths.userDataDir(), 'media-manifest.json'), log: app.log, state: {} });
          // the folders chosen here, even while "Same as master" doesn't use them
          const maps = store.savedMediaMappings();
          const roots = (await job.roots()).map(r => {
            const m = maps.find(x => x.from.toLowerCase() === r.root.toLowerCase());
            return { ...r, to: m ? m.to : '' };
          });
          return json(res, { roots, mode: store.mediaMode() });
        } catch (e) { return json(res, { roots: [], mode: store.mediaMode(), error: e.message }, 502); }
      }
      case '/api/slave/config': {
        const c = store.slaveConfig();
        return json(res, { master_host: c.master_host, master_name: c.master_name, master_obs_port: c.master_obs_port,
                           master_dashboard_port: c.master_dashboard_port, password_set: !!c.master_obs_password,
                           media_mappings: store.mediaMappings(), media_mode: store.mediaMode() });
      }
      default:
        return json(res, { error: 'unknown route' }, 404);
    }
  }

  async function post(url, body, req, res) {
    const p = url.pathname;
    // lock mode: only unlocking (and quitting from the tray icon) is possible,
    // and cutting the tally (STOP TALLY must always work)
    const panicCut = p === '/api/tally/panic' && body && body.cut === true;
    if (store.locked() && p !== '/api/lock' && p !== '/api/app/quit' && !panicCut) {
      return json(res, { error: 'locked - unlock first (padlock at the top)' }, 423);
    }
    const slave = store.role() === 'slave';
    // A slave is driven by its master: nothing that changes playback here.
    if (slave && (p.startsWith('/api/player/') || p.startsWith('/api/playlist') || p === '/api/active_playlist')) {
      return json(res, { error: 'this machine is a slave - playback is driven by the master' }, 409);
    }
    switch (p) {
      case '/api/playlist': {
        if (!Store.safeName(body.name)) return json(res, { error: "'name' is required" }, 400);
        // the cue on air can't be changed (moving the others around it is fine)
        const onAir = app.isPlaying() && body.name === store.activePlaylistName() ? app.player.current : null;
        if (onAir) {
          const next = P.normalize(body.playlist).items.find(it => it.id === onAir.id);
          const key = it => JSON.stringify([it.scene, it.duration, it.transition, it.video_ref, it.enabled !== false]);
          if (!next || key(next) !== key(onAir)) return json(res, { error: 'the cue on air can\'t be changed' }, 409);
        }
        const pl = store.savePlaylist(body.name, body.playlist);
        pl.default_transition = store.defaultTransition();
        pl.default_duration = store.defaultDuration();
        app.wake();
        return json(res, { ok: true, playlist: pl, rev: store.revision(body.name), total: P.totalDuration(pl) });
      }
      case '/api/playlist/create': {
        const name = Store.safeName(body.name);
        if (!name) return json(res, { error: 'invalid name' }, 400);
        if (store.exists(name)) return json(res, { error: `a playlist named "${name}" already exists` }, 409);
        const pl = body.copy_from ? store.loadPlaylist(body.copy_from) : P.emptyPlaylist();
        pl.items.forEach(it => { it.id = P.newId(); });
        store.savePlaylist(name, pl);
        return json(res, { ok: true, name });
      }
      case '/api/playlist/rename': {
        const oldName = body.old, newName = Store.safeName(body.new);
        if (!oldName || !newName || !store.exists(oldName)) return json(res, { error: 'invalid name' }, 400);
        if (store.exists(newName)) return json(res, { error: `a playlist named "${newName}" already exists` }, 409);
        if (app.isPlaying() && oldName === store.activePlaylistName()) {
          return json(res, { error: 'stop playback before renaming the playlist on air' }, 409);
        }
        store.renamePlaylist(oldName, newName);
        if (store.activePlaylistName() === oldName) store.setActivePlaylistName(newName);
        app.wake();
        return json(res, { ok: true, name: newName });
      }
      case '/api/playlist/export': {
        // "Save": into the file it was last saved to / loaded from, no question.
        // "Save to..." (save_as) or no file yet: system "Save as" dialog.
        if (!store.exists(body.name)) return json(res, { error: 'unknown playlist' }, 400);
        const known = store.playlistFile(body.name);
        let file = null;
        if (!body.save_as && known && fs.existsSync(path.dirname(known))) file = known;
        else {
          if (!dialogs.available() || app.simulate) return json(res, { fallback: true });
          file = await fileDialog('save', { title: 'Save the playlist', filter: FILE_FILTER,
            fileName: path.basename(known || `${body.name}.obsplaylist`), dir: known ? path.dirname(known) : null });
          if (!file) return json(res, { cancelled: true });
        }
        fs.writeFileSync(file, store.exportText(body.name), 'utf8');
        store.setPlaylistFile(body.name, file);
        app.log.info(`Playlist "${body.name}" saved to ${file}`);
        return json(res, { ok: true, path: file });
      }
      case '/api/playlist/import': {
        // Load from a file: system "Open" dialog, or the file content sent
        // by the dock (fallback)
        let text = body.content, fallbackName = body.filename;
        if (text == null) {
          if (!dialogs.available() || app.simulate) return json(res, { fallback: true });
          const file = await fileDialog('open', { title: 'Load a playlist', filter: FILE_FILTER });
          if (!file) return json(res, { cancelled: true });
          text = fs.readFileSync(file, 'utf8');
          fallbackName = file;
        }
        const stem = path.basename(String(fallbackName || 'playlist')).replace(/\.(obsplaylist|ya?ml)$/i, '');
        try {
          const name = store.importText(text, stem);
          if (body.content == null) store.setPlaylistFile(name, fallbackName);   // "Save" writes back there
          app.log.info(`Playlist loaded as "${name}"`);
          return json(res, { ok: true, name });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }
      case '/api/active_playlist': {
        if (!body.name || !store.exists(body.name)) return json(res, { error: 'unknown playlist' }, 400);
        if (app.isPlaying() && body.name !== store.activePlaylistName()) {
          return json(res, { error: 'stop playback before switching playlist' }, 409);
        }
        store.setActivePlaylistName(body.name);
        app.wake();
        return json(res, { ok: true });
      }
      case '/api/player/play': app.play(parseInt(body.index, 10) || 0); return json(res, { ok: true });
      case '/api/player/stop': app.stop(); return json(res, { ok: true });
      case '/api/player/next': app.next(); return json(res, { ok: true });
      case '/api/settings': {
        delete body.obs;   // OBS on this PC: read from OBS itself, not settable here
        store.setGeneralSettings(body);
        const after = store.generalSettings();
        app.wake();
        // port / network access: the server is already listening, a restart applies them
        const l = app.listening || {};
        const restart = after.dashboard.port !== l.port || after.dashboard.bind !== l.bind;
        return json(res, { ok: true, settings: after, restart_needed: restart });
      }
      case '/api/error/clear':
        app.lastError = null;
        return json(res, { ok: true });
      case '/api/tally/panic':
        // STOP TALLY (Noar): cut / turn on the whole tally. Cut: nothing is sent to
        // any switcher any more (tally/guard.js); OBS and master / slave go on
        return json(res, { ok: true, cut: app.tally.setCut(body.cut !== false) });
      case '/api/lock':
        store.setLocked(!!body.locked);
        app.log.info(body.locked ? 'Locked' : 'Unlocked');
        return json(res, { ok: true, locked: store.locked() });
      case '/api/role': {
        if (body.role !== 'master' && body.role !== 'slave') return json(res, { error: 'role must be master or slave' }, 400);
        app.setRole(body.role);
        return json(res, { ok: true, role: store.role() });
      }
      case '/api/slave/connect': {
        // the master picked in the scan (or typed): check the password first
        const host = String(body.host || '').trim();
        const port = parseInt(body.port, 10) || 4455;
        const password = String(body.password || '');
        if (!host) return json(res, { error: 'master address missing' }, 400);
        let r = { ok: true };
        if (!app.simulate) r = await discovery.testObs(host, port, password);
        else if (!password) r = { ok: false, wrong_password: true, error: 'Wrong password' };
        if (!r.ok) return json(res, { ok: false, error: r.error, wrong_password: !!r.wrong_password });
        let name = String(body.name || '');
        const dash = parseInt(body.dashboard_port, 10) || 8090;
        if (!name && !app.simulate) { const info = await discovery.appInfo(host, dash); if (info) name = info.name; }
        store.setSlaveConfig({ master_host: host, master_name: name, master_obs_port: port,
                               master_obs_password: password, master_dashboard_port: dash });
        app.log.info(`Master set: ${name || host} (${host}:${port})`);
        app.wake();
        app.follower.check();
        return json(res, { ok: true });
      }
      case '/api/slave/sync':
      case '/api/slave/sync_scenes':
        if (store.role() !== 'slave') return json(res, { error: 'this PC is not a slave' }, 409);
        // what to sync: media, obs (general OBS settings), scenes (all by default)
        return json(res, { ok: true, started: app.sceneSync.start({ media: p === '/api/slave/sync' && body.media !== false,
                                                                    obs: body.obs !== false, scenes: body.scenes !== false }) });
      case '/api/slave/free_run':
        // the dock's button: stop following the master (free run), or follow it again
        if (store.role() !== 'slave') return json(res, { error: 'this PC is not a slave' }, 409);
        store.setSlaveConfig({ free_run: !!body.on });
        app.log.info(body.on ? 'Free run: this PC no longer follows its master' : 'Following the master again');
        app.wake();
        app.follower.check();
        return json(res, { ok: true, free_run: !!body.on });
      case '/api/slave/auto_sync':
        store.setSlaveConfig({ auto_sync: !!body.on });
        app.log.info(`Auto sync ${body.on ? 'on' : 'off'}`);
        return json(res, { ok: true });
      case '/api/slave/sync_cancel':
        app.sceneSync.cancel();
        return json(res, { ok: true });
      case '/api/slave/update':
        // install the master's newer version on this PC
        if (store.role() !== 'slave') return json(res, { error: 'slaves only' }, 400);
        if (app.updater.busy()) return json(res, { error: 'already updating' }, 409);
        app.updater.run().catch(e => app.log.error(`Update: ${e.message}`));
        return json(res, { ok: true });
      case '/api/slave/update_cancel':
        app.updater.cancel();
        return json(res, { ok: true });
      case '/api/slave/fallback':
        // master lost: show a scene of this PC ('' = none), or play on the playlist
        if (body.scene !== undefined) store.setSlaveConfig({ fallback_scene: String(body.scene || '') });
        if (body.mode === 'scene' || body.mode === 'continue') store.setSlaveConfig({ fallback_mode: body.mode });
        return json(res, { ok: true });
      case '/api/slave/media_folder': {
        // where a master folder goes on this PC: typed, or chosen in a system dialog
        if (!body.from) return json(res, { error: "'from' is required" }, 400);
        let to = body.to != null ? String(body.to).trim() : null;
        if (body.choose) {
          if (!dialogs.available() || app.simulate) return json(res, { fallback: true });
          to = await folderDialog(`Where to put ${body.from} on this PC`);
          if (!to) return json(res, { cancelled: true });
        }
        store.setMediaMapping(body.from, to);
        return json(res, { ok: true, mappings: store.mediaMappings() });
      }
      case '/api/slave/media_mode':
        // Settings > Media location: same paths as the master, or custom folders
        try { store.setMediaMode(body.mode); } catch (e) { return json(res, { error: e.message }, 400); }
        return json(res, { ok: true, mode: store.mediaMode() });
      case '/api/app/quit':
        if (!isLocal(req)) return json(res, { error: 'this PC only' }, 403);
        json(res, { ok: true });
        return app.quit();
      default:
        return json(res, { error: 'unknown route' }, 404);
    }
  }

  function del(url, res) {
    if (url.pathname !== '/api/playlist') return json(res, { error: 'unknown route' }, 404);
    const name = url.searchParams.get('name');
    if (!name) return json(res, { error: "missing 'name'" }, 400);
    if (store.role() === 'slave') return json(res, { error: 'this machine is a slave' }, 409);
    if (store.locked()) return json(res, { error: 'locked - unlock first (padlock at the top)' }, 423);
    if (name === store.activePlaylistName() && app.isPlaying()) {
      return json(res, { error: 'stop playback before deleting the playlist on air' }, 409);
    }
    store.deletePlaylist(name);
    if (name === store.activePlaylistName()) {
      let rest = store.listPlaylists();
      if (!rest.length) { store.savePlaylist('default', P.emptyPlaylist()); rest = ['default']; }
      store.setActivePlaylistName(rest[0]);
      app.wake();
    }
    return json(res, { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!hostAllowed(req, app)) return json(res, { error: 'unknown address' }, 421);
      if (req.method === 'POST' || req.method === 'DELETE') {
        const why = changeAllowed(req);
        if (why) { app.log.warn(`Refused ${req.method} ${url.pathname} from ${req.socket.remoteAddress}: ${why}`); return json(res, { error: why }, 403); }
      }
      if (req.method === 'GET') return await get(url, req, res);
      if (req.method === 'DELETE') return del(url, res);
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return json(res, { error: 'invalid JSON' }, 400);
        return await post(url, body, req, res);
      }
      json(res, { error: 'method not allowed' }, 405);
    } catch (e) {
      app.log.error(`HTTP ${req.method} ${url.pathname}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, { error: e.message }, 500);
    }
  });
  server.on('error', e => {
    app.log.error(e.code === 'EADDRINUSE'
      ? `Port ${port} is already used - is OBS Conductor already running?`
      : `Server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, bind);
  return server;
}

module.exports = { startServer };
