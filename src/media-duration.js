'use strict';
/*
 * Length of a video file read from the file itself, when OBS gives none.
 *
 * OBS only reports a length for a file it has opened: a Media Source with
 * "Close file when inactive", a source not played yet, a VLC source, or some
 * files OBS's decoder doesn't report (seen with ProRes .mov) come back
 * without one. The companion runs on the same PC as OBS, so it can read the
 * file: QuickTime / MP4 files (.mov .mp4 .m4v - ProRes, H.264, HEVC, DNx in
 * .mov...) carry their length in the "mvhd" header. Only a few bytes are
 * read, even when that header sits at the end of a 100 GB file.
 *
 * Other containers (MXF, MKV, AVI...) are not read: their length stays
 * unknown, to be typed by hand.
 */

const fs = require('fs');

const QT_EXT = /\.(mov|mp4|m4v|qt|3gp)$/i;

/** Length in seconds, or null. Never throws. */
function fileDuration(file) {
  if (!file || !QT_EXT.test(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const moov = findBox(fd, 0, size, 'moov');
    if (!moov) return null;
    const mvhd = findBox(fd, moov.data, moov.end, 'mvhd');
    if (!mvhd) return null;
    const b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, mvhd.data);
    let timescale, duration;
    if (b[0] === 1) {          // version 1: 64-bit dates and duration
      timescale = b.readUInt32BE(20);
      duration = Number(b.readBigUInt64BE(24));
    } else {
      timescale = b.readUInt32BE(12);
      duration = b.readUInt32BE(16);
    }
    if (!timescale || !duration || duration === 0xffffffff) return null;   // fragmented / unknown
    return duration / timescale;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

/** First box of that type between start and end: {data, end} offsets. */
function findBox(fd, start, end, type) {
  const h = Buffer.alloc(16);
  let pos = start;
  for (let guard = 0; pos + 8 <= end && guard < 10000; guard++) {
    if (fs.readSync(fd, h, 0, 16, pos) < 8) return null;
    let len = h.readUInt32BE(0);
    let header = 8;
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); header = 16; }   // 64-bit size
    else if (len === 0) len = end - pos;                                   // up to the end
    if (len < header) return null;                                         // broken file
    if (h.toString('latin1', 4, 8) === type) return { data: pos + header, end: Math.min(pos + len, end) };
    pos += len;
  }
  return null;
}

/** The file played by an OBS media input, from its settings (Media Source:
 *  local file; VLC source: its file when it plays only one). */
function inputFile(inputKind, settings) {
  const s = settings || {};
  if (inputKind === 'ffmpeg_source') return s.is_local_file === false ? null : (s.local_file || null);
  if (inputKind === 'vlc_source') {
    const list = (s.playlist || []).filter(p => p && p.value && !p.hidden);
    return list.length === 1 ? list[0].value : null;   // several files: no single length
  }
  return null;
}

module.exports = { fileDuration, inputFile };
