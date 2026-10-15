'use strict';
/*
 * Slave "Sync", step 3: the master's general OBS settings, copied into this
 * PC's OBS through the WebSocket (no OBS restart, no file to copy).
 *
 * Copied: canvas (base) and output resolution, FPS, and the profile values
 * listed in PARAMS (downscale filter, colour format / space / range, HDR
 * levels; audio sample rate and channels, which OBS only applies at its next
 * start).
 * Never copied: outputs (stream service and key, recording format, path and
 * encoders: they depend on each PC's hardware and folders), audio / video
 * devices, hotkeys.
 *
 * OBS refuses to change its video while an output is on (stream, recording,
 * virtual camera, replay buffer): the video part then waits for the next
 * Sync and the dock says why.
 */

const PARAMS = [
  // [category, name, label, applies only after an OBS restart, written after
  //  the video reset (SetVideoSettings always stores the FPS as a fraction:
  //  OBS then shows "Fractional FPS Value"; these put back the master's way
  //  of setting it, e.g. "Common FPS Values: 50")]
  ['Video', 'ScaleType', 'downscale filter', false],
  ['Video', 'ColorFormat', 'colour format', false],
  ['Video', 'ColorSpace', 'colour space', false],
  ['Video', 'ColorRange', 'colour range', false],
  ['Video', 'SdrWhiteLevel', 'SDR white level', false],
  ['Video', 'HdrNominalPeak', 'HDR peak level', false],
  ['Video', 'FPSType', 'FPS mode', false, true],
  ['Video', 'FPSCommon', 'FPS (common value)', false, true],
  ['Video', 'FPSInt', 'FPS (integer)', false, true],
  ['Video', 'FPSNum', 'FPS numerator', false, true],
  ['Video', 'FPSDen', 'FPS denominator', false, true],
  ['Audio', 'SampleRate', 'audio sample rate', true],
  ['Audio', 'ChannelSetup', 'audio channels', true],
];

const VIDEO_KEYS = ['baseWidth', 'baseHeight', 'outputWidth', 'outputHeight', 'fpsNumerator', 'fpsDenominator'];

const fps = v => {
  const n = v.fpsNumerator / (v.fpsDenominator || 1);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

/** This OBS's settings: {video, params: [{category, name, value, default}]}. */
async function read(obs) {
  const v = await obs.call('GetVideoSettings');
  const video = {};
  for (const k of VIDEO_KEYS) video[k] = v[k];
  const params = [];
  for (const [category, name] of PARAMS) {
    try {
      const r = await obs.call('GetProfileParameter', { parameterCategory: category, parameterName: name });
      params.push({ category, name, value: r.parameterValue ?? null, default: r.defaultParameterValue ?? null });
    } catch (_) { /* unknown to this OBS: left alone */ }
  }
  return { video, params };
}

const effective = p => (p ? (p.value ?? p.default) : null);

/** What differs between the master's settings and this PC's: [{kind, ...}]. */
function diff(master, local) {
  const out = [];
  const mv = master.video, lv = local.video;
  if (mv.baseWidth !== lv.baseWidth || mv.baseHeight !== lv.baseHeight) out.push({ kind: 'video', label: `canvas ${mv.baseWidth}x${mv.baseHeight}` });
  if (mv.outputWidth !== lv.outputWidth || mv.outputHeight !== lv.outputHeight) out.push({ kind: 'video', label: `output ${mv.outputWidth}x${mv.outputHeight}` });
  if (mv.fpsNumerator * (lv.fpsDenominator || 1) !== lv.fpsNumerator * (mv.fpsDenominator || 1)) out.push({ kind: 'video', label: `${fps(mv)} fps` });
  for (const p of master.params) {
    const def = PARAMS.find(d => d[0] === p.category && d[1] === p.name);
    const mine = local.params.find(q => q.category === p.category && q.name === p.name);
    if (!def || !mine) continue;                     // this OBS doesn't know it
    if (String(effective(p) ?? '') === String(effective(mine) ?? '')) continue;
    const kind = def[4] ? 'fps_param' : p.category === 'Video' ? 'video_param' : 'param';
    out.push({ kind, param: p, label: `${def[2]} ${effective(p) ?? 'default'}`, restart: def[3] });
  }
  return out;
}

/** An output is on (OBS then refuses video changes). */
async function outputOn(obs) {
  try {
    const r = await obs.call('GetOutputList');
    return (r.outputs || []).some(o => o.outputActive);
  } catch (_) { return false; }   // can't tell: OBS will say it
}

/**
 * Makes this OBS match the master's settings.
 * Returns {changed: [labels], restart: bool, error: string|null}.
 */
async function apply(obs, master, log) {
  const local = await read(obs);
  const changes = diff(master, local);
  const res = { changed: [], restart: false, error: null };
  if (!changes.length) return res;
  // (fps_param changes are handled after the video part below)
  const videoChanges = changes.filter(c => c.kind === 'video' || c.kind === 'video_param');
  let videoDone = false;
  const set = p => obs.call('SetProfileParameter', { parameterCategory: p.category, parameterName: p.name, parameterValue: p.value });

  // values only read at OBS's start: written now, applied at its next start
  for (const c of changes.filter(x => x.kind === 'param')) {
    try { await set(c.param); res.changed.push(c.label); res.restart = res.restart || c.restart; }
    catch (e) { log.warn(`OBS settings: ${c.label} not set (${e.message})`); }
  }
  if (videoChanges.length) {
    if (await outputOn(obs)) {
      res.error = 'Video settings not changed: an output is on here (stream, recording, virtual camera)';
    } else {
      try {
        // colour values first: the video reset below reads them
        for (const c of videoChanges.filter(x => x.kind === 'video_param')) await set(c.param);
        await obs.call('SetVideoSettings', { ...master.video });
        res.changed.push(...videoChanges.map(c => c.label));
        videoDone = true;
      } catch (e) {
        res.error = `Video settings not changed: ${e.message}`;
      }
    }
  } else videoDone = true;
  // the master's way of setting its FPS, written after the reset (it doesn't
  // change the rate itself; only when the video went through)
  if (videoDone) {
    const fpsWay = master.params.filter(p => PARAMS.some(d => d[4] && d[0] === p.category && d[1] === p.name));
    let fpsChanged = false;
    const now = fpsWay.length ? (await read(obs)).params : [];
    for (const p of fpsWay) {
      const mine = now.find(q => q.category === p.category && q.name === p.name);
      if (!mine || String(effective(p) ?? '') === String(effective(mine) ?? '')) continue;
      try { await set(p); fpsChanged = true; } catch (e) { log.warn(`OBS settings: ${p.name} not set (${e.message})`); }
    }
    if (fpsChanged && !res.changed.some(l => / fps$/.test(l))) res.changed.push('FPS mode');
  }
  if (res.changed.length) log.info(`OBS settings copied from the master: ${res.changed.join(', ')}${res.restart ? ' (audio: at the next OBS start)' : ''}`);
  if (res.error) log.warn(`OBS settings: ${res.error}`);
  return res;
}

module.exports = { PARAMS, read, diff, apply };
