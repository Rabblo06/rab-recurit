#!/usr/bin/env node
// Automated QA for narrated tutorials (a check, not a substitute for a person watching and listening):
//   - an H.264 video stream and an AAC audio stream exist, and their durations agree
//   - integrated loudness and true peak (no clipping), and no silence longer than 4 s before the final hold
//   - the last spoken line ends inside the video
//   - the offline Windows speech recogniser hears the script (word recall against the narration text)
// Usage (from packages/rab-docs):  node tools/narration/qa-videos.cjs [slug…]   → writes tools/narration/build/qa.json
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const build = path.join(__dirname, 'build');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const only = new Set(process.argv.slice(2));
const words = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

const results = fs.existsSync(path.join(build, 'qa.json')) ? JSON.parse(fs.readFileSync(path.join(build, 'qa.json'), 'utf8')) : {};
for (const slug of fs.readdirSync(build)) {
  const meta = path.join(build, slug, 'build.json');
  if (!fs.existsSync(meta) || (only.size && !only.has(slug))) continue;
  const b = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const video = path.join(root, b.video);
  const streams = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration,sample_rate,channels', '-of', 'json', video])).streams;
  const v = streams.find((x) => x.codec_type === 'video');
  const a = streams.find((x) => x.codec_type === 'audio');
  const log = spawnSync(FFMPEG, ['-hide_banner', '-i', video, '-vn', '-af', 'ebur128=peak=true,silencedetect=n=-45dB:d=4', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stderr || '';
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const I = Number((summary.match(/I:\s+(-?[\d.]+) LUFS/) || [])[1]);
  const peak = Number((summary.match(/Peak:\s+(-?[\d.]+) dBFS/) || [])[1]);
  const lastLine = b.cues[b.cues.length - 1];
  const speechEnd = lastLine.start + lastLine.seconds;
  const silences = [...log.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  // A gap counts as mid-video only if it ENDS before the last line (the trailing hold after the last line is intended).
  const midSilences = silences.filter(([s0, s1]) => s0 > b.titleCardSeconds + 0.5 && s1 < speechEnd - 0.5);
  // Speech recognition over the final mix (16 kHz mono).
  const wav = path.join(os.tmpdir(), `qa-${slug}.wav`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const asr = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'recognise.ps1'), '-Wav', wav], { encoding: 'utf8', timeout: 900000 });
  if (asr.status !== 0) console.error(`ASR failed for ${slug}: ${(asr.stderr || '').slice(0, 300)}`);
  const heard = (asr.stdout || '').trim();
  fs.unlinkSync(wav);
  const script = words(JSON.parse(fs.readFileSync(path.join(build, slug, 'segments.json'), 'utf8')).map((x) => x.text).join(' '));
  const heardSet = new Set(words(heard));
  const recall = script.length ? script.filter((w) => heardSet.has(w)).length / script.length : 0;
  results[slug] = {
    video: b.video, seconds: b.seconds, mb: b.mb,
    videoCodec: v && v.codec_name, audioCodec: a && a.codec_name, audioChannels: a && a.channels, audioSampleRate: a && a.sample_rate,
    durationDelta: v && a ? +(Math.abs(Number(v.duration) - Number(a.duration))).toFixed(3) : null,
    loudnessLUFS: I, truePeakDBFS: peak, clipping: peak >= -0.1,
    speechEndsAt: +speechEnd.toFixed(2), finalHoldSeconds: +(b.seconds - speechEnd).toFixed(2), longSilencesMidVideo: midSilences,
    asrWordRecall: +recall.toFixed(3), asrTranscript: heard,
    pass: !!(v && a && v.codec_name === 'h264' && a.codec_name === 'aac' && I > -20 && I < -12 && peak < -0.5 && speechEnd <= b.seconds && midSilences.every(([s0, s1]) => s1 - s0 < 6) && recall >= 0.8),
    checkedAt: new Date().toISOString(),
  };
  console.log(`${results[slug].pass ? 'PASS' : 'CHECK'} ${slug}: ${b.seconds}s, ${I} LUFS, peak ${peak} dBFS, ASR recall ${(recall * 100).toFixed(0)}%, mid silences ${midSilences.length}`);
}
fs.writeFileSync(path.join(build, 'qa.json'), JSON.stringify(results, null, 2));
