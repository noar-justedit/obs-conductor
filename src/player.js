'use strict';
/*
 * Sequential playlist engine - pure logic, no OBS, no timers.
 *
 * A playlist is a list of items played one after the other. Each item stays
 * on air for its own duration (seconds) and goes on air with either the
 * playlist's default transition or its own forced one.
 *
 * main.js calls tick(now) whenever an item may be due; tick returns the
 * switch to send to OBS, if any. Keeping this free of OBS makes it testable
 * (test/player.test.js).
 *
 * Playlist format (one YAML file per playlist, see store.js):
 *
 *   default_transition: {name: "Fade", duration_ms: 500}   # both set from the
 *   default_duration: 10                                   # general settings
 *   loop: false               # start again from the top after the last cue
 *   end_action: "stop"        # without loop: stop (stay on the last cue) | scene
 *   end_scene: ""             # used when end_action is "scene"
 *   items:
 *     - id: "a1b2c3d4"
 *       scene: "Intro"
 *       duration: 30          # seconds, decimals allowed; null = the default
 *       transition: null      # or {name: "Cut", duration_ms: 0}
 *       video_ref: null       # video source chosen as duration reference
 *       enabled: true         # false = skipped (can be switched live)
 *
 * Durations count from the moment the switch is sent to OBS, transition
 * included: the playlist's total length is simply the sum of durations.
 */

const crypto = require('crypto');

const MIN_DURATION = 0.5;      // seconds - shorter items are clamped up
const DEFAULT_DURATION = 10;   // default of the "Default scene duration" setting
const END_ACTIONS = ['stop', 'scene'];

const STOPPED = 'stopped';
const PLAYING = 'playing';
const ENDED = 'ended';

const newId = () => crypto.randomBytes(4).toString('hex');

function emptyPlaylist() {
  return {
    default_transition: { name: 'Fade', duration_ms: 500 },
    default_duration: DEFAULT_DURATION,
    loop: false,
    end_action: 'stop',
    end_scene: '',
    items: [],
  };
}

function cleanTransition(t) {
  if (!t || typeof t !== 'object' || !t.name) return null;
  const ms = parseInt(t.duration_ms, 10);
  return { name: String(t.name), duration_ms: Number.isFinite(ms) && ms > 0 ? ms : 0 };
}

/** Accepts whatever was read from disk or posted by the dock and returns a
 *  well-formed playlist. Also converts the pre-2.0 format (a bare list of
 *  {scene, time, duration_seconds, enabled}). */
function normalize(data) {
  const pl = emptyPlaylist();
  if (Array.isArray(data)) {
    data = {
      items: data
        .filter(e => e && typeof e === 'object' && e.scene && e.enabled !== false)
        .map(e => ({ scene: e.scene, duration: e.duration_seconds })),
    };
  }
  if (!data || typeof data !== 'object') return pl;

  const dt = cleanTransition(data.default_transition);
  if (dt) pl.default_transition = dt;
  const dd = cleanDuration(data.default_duration);
  if (dd != null) pl.default_duration = dd;
  if (END_ACTIONS.includes(data.end_action)) pl.end_action = data.end_action;
  // loop used to be an end action (before 1.1): read it as the switch
  pl.loop = data.loop === true || data.end_action === 'loop';
  pl.end_scene = String(data.end_scene || '');

  const seen = new Set();
  for (const it of Array.isArray(data.items) ? data.items : []) {
    if (!it || typeof it !== 'object' || !it.scene) continue;
    let id = String(it.id || newId());
    if (seen.has(id)) id = newId();
    seen.add(id);
    pl.items.push({
      id,
      scene: String(it.scene),
      duration: cleanDuration(it.duration),   // null: follows the default
      transition: cleanTransition(it.transition),
      // the video chosen as duration reference in the dock (display only)
      video_ref: it.video_ref ? String(it.video_ref) : null,
      enabled: it.enabled !== false,
    });
  }
  return pl;
}

/** Seconds (min 0.5, 3 decimals) or null when empty / not a number. */
function cleanDuration(v) {
  if (v == null || v === '') return null;
  const d = parseFloat(v);
  return Number.isFinite(d) ? Math.max(MIN_DURATION, Math.round(d * 1000) / 1000) : null;
}

/** How long a cue stays on air: its own duration, or the default one. */
const durationOf = (pl, it) => (it.duration != null ? it.duration : (pl.default_duration || DEFAULT_DURATION));

const isOn = it => it.enabled !== false;
/** Length of what will play: disabled cues don't count. */
const totalDuration = pl => pl.items.reduce((a, it) => a + (isOn(it) ? durationOf(pl, it) : 0), 0);

class Player {
  constructor() {
    this.state = STOPPED;
    this.playlist = emptyPlaylist();
    this.index = -1;          // item on air
    this.itemId = null;
    this.current = null;      // copy of the item on air (survives its deletion)
    this.startedAt = null;    // clock time (seconds) the item went on air
    this.endsAt = null;
    this.loops = 0;
    this.skipped = [];        // scenes skipped because missing in OBS
    this._pending = null;     // switch waiting to be picked up by tick()
  }

  // -- playlist edits -------------------------------------------------

  /** Called whenever the playlist file changes. While playing, the item on
   *  air keeps running; it is found again by its id so reordering other
   *  rows doesn't disturb it, and an edit of its duration applies. */
  setPlaylist(pl) {
    this.playlist = pl;
    if (this.state !== PLAYING) return;
    const items = pl.items;
    const i = items.findIndex(it => it.id === this.itemId);
    if (i >= 0) {
      this.index = i;
      this.current = { ...items[i] };
      this.endsAt = this.startedAt + durationOf(pl, items[i]);
      return;
    }
    // The item on air was deleted: it finishes its time, then playback goes
    // on with whatever now sits at its position.
    this.index = Math.min(this.index, items.length) - 1;
  }

  /** The general settings (default transition and duration). A cue on air
   *  without its own duration follows a new default at once. */
  setDefaults(transition, duration) {
    this.playlist.default_transition = transition;
    const changed = this.playlist.default_duration !== duration;
    this.playlist.default_duration = duration;
    if (changed && this.state === PLAYING && this.current && this.current.duration == null && this.startedAt != null) {
      this.endsAt = this.startedAt + durationOf(this.playlist, this.current);
    }
  }

  // -- transport ------------------------------------------------------

  /** First enabled cue at or after `from`, -1 if none. */
  _nextOn(from) {
    const items = this.playlist.items;
    for (let i = Math.max(0, from); i < items.length; i++) if (isOn(items[i])) return i;
    return -1;
  }

  play(now, fromIndex = 0) {
    const items = this.playlist.items;
    if (!items.length) return;
    fromIndex = Math.max(0, Math.min(parseInt(fromIndex, 10) || 0, items.length - 1));
    // a disabled cue clicked: start at the next enabled one
    let i = this._nextOn(fromIndex);
    if (i < 0 && this.playlist.loop) i = this._nextOn(0);
    if (i < 0) return;
    this.state = PLAYING;
    this.loops = 0;
    this.skipped = [];
    this._go(i, now);
  }

  /** Goes on with a playlist another machine was playing: item `itemId` on
   *  air, `remaining` seconds left (a slave whose master is lost). The scene
   *  is already on air: nothing is sent until the next item. */
  resume(now, itemId, remaining, loops = 0) {
    const items = this.playlist.items;
    const i = items.findIndex(it => it.id === itemId);
    if (i < 0) return false;
    const it = items[i];
    this.state = PLAYING;
    this.index = i;
    this.itemId = it.id;
    this.current = { ...it };
    this.endsAt = now + Math.max(0, remaining);
    this.startedAt = this.endsAt - durationOf(this.playlist, it);
    this.loops = loops;
    this.skipped = [];
    this._pending = null;
    return true;
  }

  stop() {
    this.state = STOPPED;
    this.index = -1;
    this.itemId = null;
    this.current = null;
    this.startedAt = this.endsAt = null;
    this._pending = null;
  }

  next(now) {
    if (this.state === PLAYING) this._advance(now);
  }

  _go(index, now) {
    const it = this.playlist.items[index];
    this.index = index;
    this.itemId = it.id;
    this.current = { ...it };
    this.startedAt = now;
    this.endsAt = now + durationOf(this.playlist, it);
    this._pending = {
      scene: it.scene,
      transition: it.transition || this.playlist.default_transition,
      itemId: it.id,
      index,
    };
  }

  _advance(now) {
    const nxt = this._nextOn(this.index + 1);      // disabled cues are skipped
    if (nxt >= 0) return this._go(nxt, now);
    if (this.playlist.loop) {
      const first = this._nextOn(0);
      if (first >= 0) {
        this.loops += 1;
        return this._go(first, now);
      }
    }
    const action = this.playlist.end_action;
    this.state = ENDED;
    this.itemId = null;
    this.current = null;
    this.index = -1;
    this.startedAt = this.endsAt = null;
    if (action === 'scene' && this.playlist.end_scene) {
      this._pending = {
        scene: this.playlist.end_scene,
        transition: this.playlist.default_transition,
        itemId: null,
        index: -1,
      };
    }
  }

  /** main.js reports a scene that doesn't exist in OBS: move on at once
   *  instead of holding it for its whole duration. */
  skipMissing(now, scene) {
    if (!this.skipped.includes(scene)) this.skipped.push(scene);
    if (this.state !== PLAYING) return;
    if (this.playlist.items.filter(isOn).every(it => this.skipped.includes(it.scene))) {
      this.stop();   // a playlist made only of missing scenes
      return;
    }
    this._advance(now);
  }

  // -- clock ----------------------------------------------------------

  /** Returns the switch to send to OBS now, or null. */
  tick(now) {
    // the next cue starts when the previous one was due to end, not when the
    // loop happened to run (a few ms late each time would add up); long late
    // (OBS away, PC asleep): from now
    if (this.state === PLAYING && !this._pending && now >= this.endsAt) this._advance(now - this.endsAt < 1 ? this.endsAt : now);
    const p = this._pending;
    this._pending = null;
    return p;
  }

  nextDeadline() {
    return this.state === PLAYING ? this.endsAt : null;
  }

  snapshot(now) {
    const items = this.playlist.items;
    const cur = this.state === PLAYING ? this.current : null;
    const onList = !!cur && this.index >= 0 && this.index < items.length && items[this.index].id === this.itemId;
    let next = null;
    if (cur) {
      const n = this._nextOn(this.index + 1);
      const first = this.playlist.loop ? this._nextOn(0) : -1;
      if (n >= 0) next = items[n].scene;
      else if (first >= 0) next = items[first].scene;
      else if (this.playlist.end_action === 'scene') next = this.playlist.end_scene || null;
    }
    const remaining = cur ? Math.max(0, this.endsAt - now) : null;
    const playlistRemaining = cur
      ? remaining + items.slice(this.index + 1).reduce((a, it) => a + (isOn(it) ? durationOf(this.playlist, it) : 0), 0)
      : null;
    return {
      state: this.state,
      index: onList ? this.index : -1,
      item_id: cur ? this.itemId : null,
      scene: cur ? cur.scene : null,
      duration: cur ? durationOf(this.playlist, cur) : null,
      remaining,
      playlist_remaining: playlistRemaining,
      next_scene: next,
      loops: this.loops,
      skipped: [...this.skipped],
    };
  }
}

module.exports = {
  Player, normalize, emptyPlaylist, totalDuration, durationOf, cleanDuration, newId,
  MIN_DURATION, DEFAULT_DURATION, STOPPED, PLAYING, ENDED,
};
