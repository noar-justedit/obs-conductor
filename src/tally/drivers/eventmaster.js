'use strict';
/*
 * Barco Event Master: E2, S3, EX, E2 Gen 2, and Encore 3 (same platform):
 * JSON-RPC over HTTP, port 9999.
 *
 * Protocol from the Bitfocus Companion module companion-module-barco-
 * eventmaster (MIT), Barco's "JSON RPC" documents (Event Master Toolset 8 /
 * 10, Encore 3 v10) and qmsk/e2 (an open E2 tally tool).
 *
 * The same address reads AND acts (cut, allTrans, activatePreset...): what
 * is sent is checked method by method. Only these five READ methods, with
 * numbers as parameters, nothing else:
 *   getFrameSettings     model (FrameTypeName: E2, S3, Encore3...)
 *   listSources          sources: id, Name, InputCfgIndex (the input)
 *   listDestinations     screens and aux outputs
 *   listContent {id}     a screen's layers: LastSrcIdx (source), PgmMode,
 *                        PvwMode (> 0: on PGM / PVW), and its backgrounds
 *   listAuxContent {id}  an aux: PgmLastSrcIndex, PvwLastSrcIndex
 * An input = an input configuration (InputCfgIndex), whatever the source.
 */

const { httpClient, register } = require('../guard');

const METHODS = Object.freeze(['getFrameSettings', 'listSources', 'listDestinations', 'listContent', 'listAuxContent']);
const PARAMS = Object.freeze(['id', 'type', 'DestOutMap']);

// the parameters each method may take (all integers)
const PARAMS_OF = Object.freeze({ getFrameSettings: [], listSources: ['type'], listDestinations: ['type'],
  listContent: ['id', 'DestOutMap'], listAuxContent: ['id'] });

/**
 * The JSON-RPC body: one of the five read methods, integer params only, and
 * EXACTLY the text OBS Conductor writes for it (rebuilt and compared: no
 * duplicate key, no extra field, nothing another JSON reader could see
 * differently).
 */
function isReadCall(body) {
  let j;
  try { j = JSON.parse(body); } catch (_) { return false; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.jsonrpc !== '2.0' || !METHODS.includes(j.method)) return false;
  if (!Number.isInteger(j.id) || j.id < 0) return false;
  const p = j.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (!Object.entries(p).every(([k, v]) => PARAMS_OF[j.method].includes(k) && Number.isInteger(v) && v >= 0 && v < 10000)) return false;
  return body === JSON.stringify({ jsonrpc: '2.0', id: j.id, method: j.method, params: p });
}
const RULES = register('eventmaster', [{
  desc: `POST /jsonrpc with method ${METHODS.join(' | ')} and integer params (${PARAMS.join(', ')}) only`,
  test: s => { const m = typeof s === 'string' && /^POST \/jsonrpc (.+)$/s.exec(s); return !!m && isReadCall(m[1]); },
}]);
const FORBIDDEN = [
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"allTrans","params":{}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"cut","params":{}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"activatePreset","params":{"id":1,"type":0}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"changeContent","params":{"id":0}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"listContent","params":{"id":"0;cut"}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"listContent","params":{"id":0,"Layers":[]}}',
  'POST /jsonrpc [{"jsonrpc":"2.0","id":1,"method":"cut"}]',
  'GET /jsonrpc',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"cut","method":"listSources","params":{}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"listSources","params":{"type":0},"params":{"id":1}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":{"x":1},"method":"listSources","params":{}}',
  'POST /jsonrpc {"jsonrpc":"2.0","id":1,"method":"listAuxContent","params":{"type":1}}',
];

const request = httpClient('eventmaster');
const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);

class Session {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.n = 0; this.frame = null; this.at = 0; }

  async call(method, params = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params });
    const r = await request(`http://${this.cfg.host}:${this.cfg.port || 9999}/jsonrpc`,
      { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, timeout: 2500 });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    let j;
    try { j = JSON.parse(r.body.toString()); } catch (_) { throw new Error('not an Event Master answer'); }
    if (j.error) throw new Error(j.error.message || 'error');
    const res = j.result || {};
    if (res.success != null && res.success !== 0) throw new Error(`${method}: error ${res.success}`);
    return res.response;
  }

  async _refresh() {
    if (!this.frame) {
      const f = await this.call('getFrameSettings');
      const fr = arr(f && f.System && f.System.FrameCollection && f.System.FrameCollection.Frame)[0] || {};
      this.frame = { type: fr.FrameType, name: fr.FrameTypeName || 'Event Master', version: fr.Version || '' };
      this.log.info(`Tally: connected to the Barco ${this.frame.name} at ${this.cfg.host}`);
    }
    const encore3 = this.frame.type === 8;
    const src = arr(await this.call('listSources', encore3 ? {} : { type: 0 }));
    const bg = encore3 ? [] : arr(await this.call('listSources', { type: 1 }).catch(() => []));
    const d = (await this.call('listDestinations', { type: 0 })) || {};
    this.srcToInput = new Map();
    this.inputs = new Map();
    for (const s of src) {
      if (s.InputCfgIndex == null || s.InputCfgIndex < 0) continue;
      this.srcToInput.set(s.id, String(s.InputCfgIndex));
      if (!this.inputs.has(String(s.InputCfgIndex))) this.inputs.set(String(s.InputCfgIndex), s.Name || `Input ${s.InputCfgIndex + 1}`);
    }
    // backgrounds: E2 / S3 count in the background list; Encore 3 in the sources
    this.bgToInput = encore3 ? this.srcToInput : new Map(bg.filter(b => b.InputCfgIndex >= 0).map(b => [b.id, String(b.InputCfgIndex)]));
    this.screens = arr(d.ScreenDestination).map(s => ({ id: s.id, name: s.Name || `Screen ${s.id + 1}` }));
    this.auxes = arr(d.AuxDestination).map(s => ({ id: s.id, name: s.Name || `Aux ${s.id + 1}` }));
    this.at = Date.now();
  }

  async read() {
    if (!this.frame || Date.now() - this.at > 10000) await this._refresh();
    const frame = this.frame;
    if (!frame) throw new Error('closed');
    const tally = {};
    for (const id of this.inputs.keys()) tally[id] = { pgm: [], pvw: [] };
    const mark = (map, src, kind, where) => { const i = map.get(src); if (i != null && tally[i] && !tally[i][kind].includes(where)) tally[i][kind].push(where); };
    for (const sc of this.screens) {
      const c = (await this.call('listContent', { id: sc.id })) || {};
      for (const l of arr(c.Layers)) {
        if (!(l.LastSrcIdx >= 0)) continue;
        if (l.PgmMode > 0) mark(this.srcToInput, l.LastSrcIdx, 'pgm', sc.name);
        if (l.PvwMode > 0) mark(this.srcToInput, l.LastSrcIdx, 'pvw', sc.name);
      }
      for (const b of arr(c.BGLyr || c.BgLyr)) {
        if (!(b.LastBGSourceIndex >= 0) || b.BGShowMatte) continue;
        mark(this.bgToInput, b.LastBGSourceIndex, b.id === 0 ? 'pgm' : 'pvw', sc.name + ' (background)');
      }
    }
    for (const ax of this.auxes) {
      const c = (await this.call('listAuxContent', { id: ax.id })) || {};
      if (c.PgmLastSrcIndex >= 0) mark(this.srcToInput, c.PgmLastSrcIndex, 'pgm', ax.name);
      if (c.PvwLastSrcIndex >= 0) mark(this.srcToInput, c.PvwLastSrcIndex, 'pvw', ax.name);
    }
    const inputs = [...this.inputs].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id);
    return { model: `Barco ${frame.name} ${frame.version}`.trim(), inputs, tally, screens: this.screens.length + this.auxes.length };
  }

  close() { this.frame = null; }
}


module.exports = {
  id: 'eventmaster', label: 'Barco E2 / S3 / EX / Encore 3', vendor: 'Barco', port: 9999, portHint: 'HTTP 9999',
  auth: null, scanPorts: [], scanHint: 'not scanned (its reads are POST requests): choose it in the list', pollMs: 700, source: 'companion-module-barco-eventmaster',
  RULES, FORBIDDEN, METHODS, isReadCall, create: (cfg, log) => new Session(cfg, log),
};
