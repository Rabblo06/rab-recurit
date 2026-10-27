#!/usr/bin/env node
// Neural, on-device narration for documentation tutorials (no network service, no account, no key).
// Writes the same segments.json the recorder's `say()` uses, so the capture is paced to the real spoken lines.
//
//   node tools/narration/synthesize-neural.cjs <script.json> <out-dir> [--engine kokoro|piper] [--voice <id>] [--speed <x>]
//
// Engines (paths come from the environment so nothing machine-specific is committed):
//   kokoro — `npx hyperframes tts` (Kokoro-82M, Apache-2.0). Needs a Python with `kokoro-onnx soundfile`:
//            CREWFLOW_TTS_PYTHON=<venv>/Scripts/python.exe   (passed to HyperFrames as HYPERFRAMES_PYTHON)
//   piper  — Piper TTS (MIT). PIPER_PYTHON=<python with piper-tts>  PIPER_VOICE=<path>/en_GB-cori-medium.onnx
// Each line is synthesised as ONE coherent sentence/paragraph (never word by word), trimmed of leading/trailing
// silence, and measured. Pronunciation fixes in the script's `pronounce` map change the spoken text only.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [scriptPath, outDir] = process.argv.slice(2);
if (!scriptPath || !outDir) { console.error('usage: synthesize-neural.cjs <script.json> <out-dir> [--engine kokoro|piper] [--voice id] [--speed x]'); process.exit(2); }
const opt = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const spec = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const engine = opt('--engine') || spec.engine || 'kokoro';
const voice = opt('--voice') || (engine === 'piper' ? path.basename(process.env.PIPER_VOICE || 'piper', '.onnx') : spec.voice || 'bf_emma');
const speed = Number(opt('--speed') || spec.speed || 1);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
fs.mkdirSync(outDir, { recursive: true });

const spoken = (text) => Object.entries(spec.pronounce || {}).reduce((t, [k, v]) => t.split(k).join(v), text);
const run = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npx', ...o }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`); return r; };
const seconds = (f) => Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.trim());

const out = [];
for (const seg of spec.segments) {
  const raw = path.join(outDir, `${seg.id}.raw.wav`);
  const file = path.join(outDir, `${seg.id}.wav`);
  const text = spoken(seg.text);
  if (engine === 'kokoro') {
    if (!process.env.CREWFLOW_TTS_PYTHON) throw new Error('Set CREWFLOW_TTS_PYTHON to a Python that has kokoro-onnx and soundfile installed');
    run('npx', ['hyperframes', 'tts', JSON.stringify(text), '--voice', voice, '--speed', String(seg.speed || speed), '-o', JSON.stringify(raw), '--json'], { env: { ...process.env, HYPERFRAMES_PYTHON: process.env.CREWFLOW_TTS_PYTHON } });
  } else if (engine === 'piper') {
    if (!process.env.PIPER_PYTHON || !process.env.PIPER_VOICE) throw new Error('Set PIPER_PYTHON and PIPER_VOICE (path to the .onnx voice)');
    // Piper speaks faster as length_scale falls; map speed>1 → shorter.
    run(process.env.PIPER_PYTHON, ['-m', 'piper', '-m', process.env.PIPER_VOICE, '-f', raw, '--length-scale', String((1 / (seg.speed || speed)).toFixed(3))], { input: text });
  } else throw new Error(`unknown engine ${engine}`);
  // Trim silence at both ends (keep ~60 ms of air), 48 kHz mono for the mix.
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse',
    '-ar', '48000', '-ac', '1', file]);
  fs.unlinkSync(raw);
  out.push({ id: seg.id, text: seg.text, file: path.basename(file), seconds: Number(seconds(file).toFixed(3)), ...(seg.pauseAfter != null ? { pauseAfter: seg.pauseAfter } : {}) });
  process.stdout.write(`${seg.id}: ${out[out.length - 1].seconds}s\n`);
}
fs.writeFileSync(path.join(outDir, 'segments.json'), JSON.stringify(out, null, 2));
const words = spec.segments.reduce((a, s) => a + s.text.split(/\s+/).filter(Boolean).length, 0);
const spokenSeconds = out.reduce((a, s) => a + s.seconds, 0);
const meta = { engine, voice, speed, words, spokenSeconds: +spokenSeconds.toFixed(2), wordsPerMinuteWhileSpeaking: Math.round(words / spokenSeconds * 60), generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, 'voice.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta));
