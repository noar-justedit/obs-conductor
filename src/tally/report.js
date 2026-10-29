'use strict';
/*
 * Tally assistant (Settings > Tally): the TEST REPORT a user sends back so a
 * new switcher can be validated. Pure text building, nothing is sent
 * anywhere by this file: the user copies it or saves it, reads it, and posts
 * it himself (GitHub issue).
 *
 * What it never contains: the password, the switcher's address (the one
 * typed in Settings becomes <address>, any private network address becomes
 * x.x.x.x), the user name field. The names of the inputs are in the raw
 * answer (needed to fix a driver): the dock tells the user.
 */

const MAX_STEPS = 24, MAX_LINE = 400, MAX_NOTES = 2000, MAX_RAW = 16000;
const RESULTS = ['ok', 'problem', 'skipped'];

/** One line of free text: no control characters, bounded. */
const clean = (s, max = MAX_LINE) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\r?\n/g, ' ').trim().slice(0, max);
const cleanBlock = (s, max = MAX_NOTES) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * Hides what must not leave this PC: the password, the address typed in
 * Settings (IP or name), network addresses (IPv4 private / CGNAT or with a
 * port, IPv6). cfg = {host, password}.
 */
function hide(text, cfg = {}) {
  let t = String(text == null ? '' : text);
  for (const secret of [cfg.password]) if (secret && String(secret).length >= 3) t = t.split(String(secret)).join('<password>');
  if (cfg.host && String(cfg.host).length >= 3) t = t.split(String(cfg.host)).join('<address>');
  // network addresses: private and CGNAT / Tailscale ranges, any address
  // followed by a port (an error text: "connect ECONNREFUSED 1.2.3.4:80"),
  // IPv6. A firmware like 27.0.0.49 is NOT one and stays readable (review 2.2.2)
  return t
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?=:\d{1,5}\b)/g, 'x.x.x.x')
    .replace(/\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g, 'x.x.x.x')
    // IPv6: 5 groups or more, or a "::" (a time like 12:30:45 stays)
    .replace(/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?:%[\w.]+)?(?![\w:])/gi, 'x:x::x');
}

/** The raw answer, as pretty text, hidden and bounded. */
function rawText(raw, cfg) {
  if (raw == null) return '';
  let s;
  try { s = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2); } catch (_) { s = String(raw); }
  s = hide(s, cfg);
  return s.length > MAX_RAW ? s.slice(0, MAX_RAW) + '\n... (cut: ' + (s.length - MAX_RAW) + ' more characters)' : s;
}

/** The steps sent by the dock, checked: unknown results and long texts can't get through. */
function cleanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, MAX_STEPS).map(s => ({
    title: clean(s && s.title, 120),
    result: RESULTS.includes(s && s.result) ? s.result : 'skipped',
    detail: clean(s && s.detail),
  })).filter(s => s.title);
}

/**
 * ctx: { version, platform, arch, date, device:{id,label}, port, has_password, model, input_count,
 *        cfg:{host,password} (only to hide them), debug (raw answer or null), debug_error }
 * body (from the dock): { steps, notes, machine, include_raw }
 */
function build(ctx, body = {}) {
  const steps = cleanSteps(body.steps);
  const count = r => steps.filter(s => s.result === r).length;
  const out = [];
  out.push('# OBS Conductor: tally test report');
  out.push('');
  out.push(`- App: OBS Conductor ${clean(ctx.version, 20)} on ${clean(ctx.platform, 20)} ${clean(ctx.arch, 20)}`.trimEnd());
  out.push(`- Date: ${clean(ctx.date, 40)}`);
  out.push(`- Switcher chosen: ${clean(ctx.device && ctx.device.label, 80) || '(none)'} [${clean(ctx.device && ctx.device.id, 30)}]`);
  out.push(`- Port: ${ctx.port ? clean(ctx.port, 10) : 'the usual one'}${ctx.has_password ? ' · a password is set (not included)' : ''}`);
  if (ctx.model) out.push(`- Model read from the switcher: ${clean(ctx.model, 120)}`);
  if (ctx.input_count != null) out.push(`- Inputs read: ${clean(ctx.input_count, 10)}`);
  if (Array.isArray(ctx.excluded) && ctx.excluded.length) out.push(`- Outputs that don't count (Settings): ${hide(ctx.excluded.map(x => clean(x, 80)).join(', '), ctx.cfg)}`);
  const machine = clean(body.machine, 200);
  if (machine) out.push(`- Model / firmware, as told by the tester: ${hide(machine, ctx.cfg)}`);
  out.push('');
  out.push(`## Result: ${count('ok')} OK · ${count('problem')} problem${count('problem') === 1 ? '' : 's'} · ${count('skipped')} skipped`);
  out.push('');
  const mark = { ok: 'OK', problem: 'PROBLEM', skipped: 'skipped' };
  steps.forEach((s, i) => out.push(`${i + 1}. [${mark[s.result]}] ${hide(s.title, ctx.cfg)}${s.detail ? ': ' + hide(s.detail, ctx.cfg) : ''}`));
  if (!steps.length) out.push('(no step done)');
  const notes = cleanBlock(body.notes);
  if (notes) { out.push(''); out.push('## Notes from the tester'); out.push(''); out.push(hide(notes, ctx.cfg)); }
  if (body.include_raw !== false) {
    out.push(''); out.push('## What the switcher answered (addresses and password hidden)'); out.push('');
    if (ctx.debug != null) { out.push('```json'); out.push(rawText(ctx.debug, ctx.cfg)); out.push('```'); }
    else out.push(`(not available${ctx.debug_error ? ': ' + hide(clean(ctx.debug_error, 200), ctx.cfg) : ''})`);
  }
  out.push('');
  return out.join('\n');
}

module.exports = { build, hide, cleanSteps, rawText, MAX_STEPS, MAX_RAW };
