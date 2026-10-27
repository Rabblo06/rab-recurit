// The film's ONE authoritative clock: lays the measured narration segments end to end and returns absolute film times.
// Everything else (footage placement, camera keys, graphics, captions, sound) is expressed against these times.
//
//   const tl = require('./timeline.cjs')(segmentsJsonPath, scriptJsonPath)
//   tl.seg['c4-approve'] -> { start, end, seconds, text, chapter, file }
'use strict';
const fs = require('fs');
const path = require('path');

const LEAD_IN = 1.4;          // silent opening beat (S00: the orange dot draws its line)
const CHAPTER_GAP = 2.9;      // minimum pause at a chapter change — the ChapterCard plays inside it
// Extra visual holds after a line (seconds). Never stretches speech; only lets the picture breathe.
const HOLDS = { 'c1-connect': 2.4, 'c3-scope': 0.4, 'c4-approve': 0.6, 'c5-accept': 0.8, 'c6-live': 0.6, 'c7-gate': 0.4, 'c8-pdf': 1.2, 'c9-dash': 1.0, 'c11-recap': 1.2, 'c11-guide': 3.6 };

module.exports = function timeline(segmentsPath, scriptPath) {
  const segs = JSON.parse(fs.readFileSync(segmentsPath, 'utf8'));
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const meta = Object.fromEntries(script.segments.map((s) => [s.id, s]));
  const seg = {};
  const order = [];
  const chapters = [];
  let t = LEAD_IN;
  segs.forEach((s, i) => {
    const m = meta[s.id];
    if (!m) throw new Error(`segment ${s.id} not in script`);
    const start = +t.toFixed(3);
    const end = +(start + s.seconds).toFixed(3);
    seg[s.id] = { id: s.id, start, end, seconds: s.seconds, text: s.text, chapter: m.chapter, file: path.join(path.dirname(segmentsPath), s.file) };
    order.push(s.id);
    if (!chapters.length || chapters[chapters.length - 1].title !== m.chapter) chapters.push({ title: m.chapter, start, firstSeg: s.id });
    const next = segs[i + 1] && meta[segs[i + 1].id];
    const gap = next && next.chapter !== m.chapter ? Math.max(m.pauseAfter ?? 0.5, CHAPTER_GAP) : (m.pauseAfter ?? 0.5);
    t = end + gap + (HOLDS[s.id] || 0);
  });
  const total = +t.toFixed(3);
  chapters.forEach((c, i) => { c.end = i + 1 < chapters.length ? chapters[i + 1].start : total; c.index = i + 1; });
  // A chapter card occupies the gap before each chapter (except the first): it ends just before the chapter's first line.
  chapters.forEach((c, i) => { if (i === 0) return; const prevSeg = seg[order[order.indexOf(c.firstSeg) - 1]]; c.card = { start: +Math.max(prevSeg.end + 0.25, c.start - 2.5).toFixed(3), end: +(c.start - 0.1).toFixed(3) }; });
  return { seg, order, chapters, total, LEAD_IN };
};
