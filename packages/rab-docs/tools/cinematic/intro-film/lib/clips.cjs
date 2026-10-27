// Footage clips for the introduction film, cut from the real captures and aligned to the ONE film clock.
//
// Web captures (tools/web/record-cinematic.cjs) are paced by the same narration segments, so each narration cue in a
// recording maps to that segment's start in the film. A clip is built piece by piece: recording time
// [cue_i, cue_i+1) is placed at film time seg_i.start and its last frame is HELD (never time-stretched) until the next
// piece — the film's extra chapter gaps and holds therefore never speed up or slow down the product.
//
// Phone captures (native Flutter on the emulator) are real-time recordings with marks; a piece is a [from, to] range of
// the recording placed at a film time, again held — never stretched — to fill its slot.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FPS = 30;
const run = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

/**
 * @param {string} recDir    capture directory (frames/, frames.json, cues.json, events.json)
 * @param {object} tl        timeline from timeline.cjs
 * @param {{segs: string[], filmStart?: number, filmEnd: number, lead?: number}} spec
 *        segs: the narration segments this clip covers (in order); the clip starts at film time `filmStart`
 *        (default: first segment's start − lead) and ends at `filmEnd`.
 * @param {string} outFile   mp4 to write (native capture resolution, constant 30 fps)
 * @returns {{file, filmStart, filmEnd, camera: Array<{t,d,rect|full}>, marks: object, size}}
 */
function webClip(recDir, tl, spec, outFile) {
  const frames = JSON.parse(fs.readFileSync(path.join(recDir, 'frames.json'), 'utf8'));
  const cues = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(recDir, 'cues.json'), 'utf8')).map((c) => [c.id, c]));
  const ev = JSON.parse(fs.readFileSync(path.join(recDir, 'events.json'), 'utf8'));
  const fps = ev.fps;
  const lead = spec.lead ?? 0;
  const filmStart = spec.filmStart ?? +(tl.seg[spec.segs[0]].start - lead).toFixed(3);
  const filmEnd = spec.filmEnd;
  // Pieces: [recFrom, recTo) → [filmFrom, filmTo)
  const pieces = spec.segs.map((id, i) => {
    if (!cues[id]) throw new Error(`${path.basename(recDir)}: no narration cue ${id}`);
    const recFrom = i === 0 ? Math.max(0, cues[id].start - (tl.seg[id].start - filmStart)) : cues[id].start;
    const nextId = spec.segs[i + 1];
    const recTo = nextId ? cues[nextId].start : frames[frames.length - 1].t + 1 / fps;
    const filmFrom = i === 0 ? filmStart : tl.seg[id].start;
    const filmTo = nextId ? tl.seg[nextId].start : filmEnd;
    return { id, recFrom, recTo, filmFrom, filmTo, cueRec: cues[id].start, cueFilm: tl.seg[id].start };
  });
  // Image list for ffmpeg's concat demuxer: each frame lasts 1/fps; the last frame of a piece is held to fill its slot.
  const lines = [];
  for (const p of pieces) {
    const a = Math.max(0, Math.round(p.recFrom * fps));
    const playable = Math.min(Math.round(p.recTo * fps), frames.length) - a;
    const slot = Math.round((p.filmTo - p.filmFrom) * fps);
    const n = Math.max(1, Math.min(playable, slot));
    for (let k = 0; k < n; k++) {
      const f = frames[a + k];
      const dur = k === n - 1 ? (slot - n + 1) / FPS : 1 / FPS;
      lines.push(`file '${path.join(recDir, f.file).replace(/\\/g, '/')}'`, `duration ${dur.toFixed(6)}`);
    }
    p.playedRec = n / fps;
  }
  lines.push(lines[lines.length - 2]); // concat demuxer quirk: repeat the last file so its duration is honoured
  const list = `${outFile}.txt`;
  fs.writeFileSync(list, lines.join('\n'));
  run(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-g', String(FPS), '-movflags', '+faststart', outFile]);
  fs.unlinkSync(list);
  // Camera cues and marks, re-timed onto the film clock piece by piece.
  const toFilm = (t) => { const p = pieces.find((x) => t >= x.recFrom - 1e-6 && t < x.recFrom + x.playedRec + 1e-6); return p ? +(p.filmFrom + (t - p.recFrom)).toFixed(3) : null; };
  const marks = Object.fromEntries(ev.events.filter((e) => e.type === 'mark').map((e) => [e.id, { ...e.bbox, t: toFilm(e.t) }]));
  const camera = ev.events.filter((e) => e.type === 'camera').map((e) => ({ id: e.id, t: toFilm(e.t + (e.offset || 0)), d: e.duration ?? 0.8, full: e.rect === 'full', marks: e.marks || [], chapter: e.chapter || null })).filter((c) => c.t != null);
  const clicks = ev.events.filter((e) => e.type === 'click').map((e) => ({ t: toFilm(e.t), x: e.x, y: e.y })).filter((c) => c.t != null);
  return { file: outFile, filmStart, filmEnd, camera, marks, clicks, size: { w: ev.viewport.width * ev.dpr, h: ev.viewport.height * ev.dpr }, dpr: ev.dpr, pieces };
}

/**
 * @param {string} video      the phone recording (mp4, portrait)
 * @param {Array<{from:number,to:number,filmFrom:number,filmTo:number}>} pieces  recording ranges placed on the film clock
 * @param {string} outFile
 */
function phoneClip(video, pieces, outFile, { width = 1080, height = 2340 } = {}) {
  const parts = [];
  pieces.forEach((p, i) => {
    const part = `${outFile}.p${i}.mp4`;
    const len = Math.min(p.to - p.from, p.filmTo - p.filmFrom);
    const hold = Math.max(0, p.filmTo - p.filmFrom - len);
    run(['-ss', p.from.toFixed(3), '-t', len.toFixed(3), '-i', video, '-vf', `fps=${FPS},scale=${width}:${height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-g', String(FPS), part]);
    parts.push(part);
  });
  const list = `${outFile}.txt`;
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outFile]);
  parts.forEach((p) => fs.unlinkSync(p)); fs.unlinkSync(list);
  return { file: outFile, filmStart: pieces[0].filmFrom, filmEnd: pieces[pieces.length - 1].filmTo, size: { w: width, h: height } };
}

module.exports = { webClip, phoneClip, FPS };
