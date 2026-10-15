'use strict';
/*
 * Slave side: finds the OBS on the local network that have their WebSocket
 * server on, so the user only has to pick the master and type its password.
 *
 * Every address of this PC's network (a.b.c.1 - a.b.c.254, for each network
 * card) is tried on two ports, many at once (2 to 4 s in all):
 *   4455  OBS's WebSocket server: OBS answers with a "Hello" telling its
 *         version and whether a password is required;
 *   8090  OBS Conductor on that PC: it answers with its name, its role
 *         (master / slave) and the port of its OBS - so a master whose OBS
 *         uses another port than 4455 is found too.
 * A master is not found when its firewall blocks those ports, or when it
 * sits on another sub-network: its address can then be typed by hand.
 */

const net = require('net');
const os = require('os');
const { ObsClient } = require('./obs');

const OBS_PORT = 4455;
const APP_PORT = 8090;

/** Addresses to try: the /24 network of each IPv4 card, this PC excluded. */
function candidateHosts(interfaces = os.networkInterfaces()) {
  const own = new Set(), prefixes = new Set();
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      own.add(a.address);
      prefixes.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  const hosts = [];
  for (const p of prefixes) for (let i = 1; i < 255; i++) {
    const h = `${p}.${i}`;
    if (!own.has(h)) hosts.push(h);
  }
  return { hosts, networks: [...prefixes].map(p => p + '.x') };
}

function tcpOpen(host, port, timeoutMs) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** OBS's WebSocket "Hello": {version, auth} or null. */
function obsHello(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    let ws, timer;
    const done = v => { clearTimeout(timer); try { ws && ws.close(); } catch (_) {} resolve(v); };
    try { ws = new WebSocket(`ws://${host}:${port}`, 'obswebsocket.json'); } catch (_) { return resolve(null); }
    timer = setTimeout(() => done(null), timeoutMs);
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.op === 0) return done({ version: m.d.obsWebSocketVersion || null, auth: !!m.d.authentication });
      } catch (_) {}
      done(null);
    };
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
  });
}

/** OBS Conductor on that PC: {name, role, version, obs_port, dashboard_port} or null. */
async function appInfo(host, port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://${host}:${port}/api/whoami`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    // 'obs-playlist': the app before it was renamed (1.2.x)
    return j && (j.app === 'obs-conductor' || j.app === 'obs-playlist') ? j : null;
  } catch (_) { return null; }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/**
 * Returns {networks, found: [{host, name, obs: {port, version, auth} | null,
 * app: {...} | null}]}, OBS Conductor masters first.
 */
async function scan({ hosts, networks, obsPort = OBS_PORT, appPort = APP_PORT,
                      concurrency = 96, timeoutMs = 700 } = {}) {
  if (!hosts) ({ hosts, networks } = candidateHosts());
  const results = await pool(hosts, concurrency, async host => {
    const [obsOpen, appOpen] = await Promise.all([tcpOpen(host, obsPort, timeoutMs), tcpOpen(host, appPort, timeoutMs)]);
    if (!obsOpen && !appOpen) return null;
    const app = appOpen ? await appInfo(host, appPort) : null;
    if (app) app.dashboard_port = appPort;
    const port = (app && app.obs_port) || obsPort;
    let obs = null;
    if (port === obsPort ? obsOpen : await tcpOpen(host, port, timeoutMs)) {
      const hello = await obsHello(host, port);
      if (hello) obs = { port, ...hello };
    }
    if (!obs && !app) return null;
    return { host, name: (app && app.name) || '', obs, app };
  });
  const rank = r => (r.app && r.app.role === 'master' ? 0 : r.app ? 1 : 2);
  const found = results.filter(Boolean).sort((a, b) => rank(a) - rank(b) ||
    a.host.localeCompare(b.host, undefined, { numeric: true }));
  return { networks: networks || [], found };
}

/** Tries the master's OBS with this password: {ok} or {ok: false, error, wrong_password}. */
function testObs(host, port, password, timeoutMs = 5000) {
  return new Promise(resolve => {
    const c = new ObsClient({ host, port, password, label: 'master OBS' });
    let settled = false;
    const finish = r => { if (settled) return; settled = true; clearInterval(poll); clearTimeout(timer); c.stop(); resolve(r); };
    c.on('connected', () => finish({ ok: true }));
    // a refused password is known as soon as OBS closes the connection
    const poll = setInterval(() => {
      if (c.lastError === 'wrong OBS websocket password') finish({ ok: false, wrong_password: true, error: 'Wrong password' });
    }, 100);
    const timer = setTimeout(() => finish({ ok: false, error: c.lastError || `no answer from ${host}:${port}` }), timeoutMs);
    c.start();
  });
}

module.exports = { candidateHosts, tcpOpen, obsHello, appInfo, scan, testObs, OBS_PORT, APP_PORT };
