#!/usr/bin/env node
// Copies finished renders into the docs (same paths the pages already embed) and QA-checks each one.
//
//   node tools/cinematic/publish.cjs <slug> [<slug> …]
//
// For each slug: videos/<area>/<slug>.mp4 (stream copy + faststart), videos/captions/<slug>.en.vtt and
// videos/posters/<slug>.webp (a frame from the middle of the first focused shot). Prints duration, streams, loudness
// and whether the moov atom comes before mdat.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const DOCS = path.resolve(__dirname, '..', '..');
const AREA = {
  'dashboard-cinematic': 'getting-started', 'overview-tour': 'getting-started', 'sidebar-shortcuts': 'getting-started',
  'add-staff': 'managers', 'assign-venue-manager-staff': 'managers', 'create-venue': 'managers', 'create-workspace': 'managers',
  'invite-manager': 'managers', 'staff-reviews': 'managers',
  'confirm-offers': 'offers', 'create-shift-send-offers': 'offers', 'staffing-pipeline': 'offers', 'venue-request-approval': 'offers',
};

for (const slug of process.argv.slice(2)) {
  const proj = path.join(__dirname, slug === 'dashboard-cinematic' ? 'dashboard-tour' : slug);
  const src = path.join(proj, 'renders', `${slug}.mp4`);
  if (!AREA[slug] || !fs.existsSync(src)) { console.error(`✗ ${slug}: no render at ${src}`); process.exitCode = 1; continue; }
  const dst = path.join(DOCS, 'videos', AREA[slug], `${slug}.mp4`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', dst]);
  fs.copyFileSync(path.join(proj, `${slug}.en.vtt`), path.join(DOCS, 'videos', 'captions', `${slug}.en.vtt`));
  const cam = JSON.parse(fs.readFileSync(path.join(proj, 'camera.json'), 'utf8'));
  const shot = cam.keyframes.find((k) => k.zoom > 1.2) || cam.keyframes[1] || cam.keyframes[0];
  const at = (shot.t + (shot.duration || 0) + 1.2).toFixed(2);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at, '-i', dst, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', path.join(DOCS, 'videos', 'posters', `${slug}.webp`)]);
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,profile,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', dst], { encoding: 'utf8' }));
  const loud = spawnSync(FFMPEG, ['-hide_banner', '-i', dst, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const I = (loud.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop();
  const peak = (loud.match(/Peak:\s+(-?[\d.]+) dBFS/g) || []).pop();
  const head = fs.readFileSync(dst).subarray(0, 4096).toString('latin1');
  const faststart = head.indexOf('moov') > -1 && (head.indexOf('mdat') === -1 || head.indexOf('moov') < head.indexOf('mdat'));
  const v = probe.streams.find((s) => s.width); const a = probe.streams.find((s) => s.sample_rate);
  console.log(`✓ ${slug}: ${(+probe.format.duration).toFixed(1)}s ${v.codec_name} ${v.profile} ${v.width}x${v.height} ${v.r_frame_rate} | ${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch | ${I} ${peak} | faststart ${faststart} | poster @${at}s | ${(fs.statSync(dst).size / 1e6).toFixed(1)} MB`);
}
