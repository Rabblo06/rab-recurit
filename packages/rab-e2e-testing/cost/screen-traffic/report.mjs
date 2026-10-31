#!/usr/bin/env node
// Assembles one screen-traffic run directory into results.md + results.json: every server window (analysis-*.json), the
// web client run (web/web-summary.json) and the Flutter emulator run (flutter/flutter-summary.json) when present.
//   node report.mjs <out dir>
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const j = (f) => (fs.existsSync(path.join(OUT, f)) ? JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) : null);
const md = (f) => (fs.existsSync(path.join(OUT, f)) ? fs.readFileSync(path.join(OUT, f), 'utf8') : '');
const windows = fs.readdirSync(OUT).filter((f) => /^analysis-.*\.json$/.test(f)).map((f) => f.slice(9, -5));
const order = (l) => (l === 'mix-visible' ? 0 : l === 'mix-hidden' ? 1 : 2);
windows.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
const meta = md('screen-traffic-meta.txt');
const L = ['# Phase C1 screen traffic', '', '```', meta.trim(), '```', '', 'Labels: (M) MEASURED in this run, (D) DERIVED from measured values, basis DERIVED = schedule read from code that cannot run here (iOS).', ''];
const idle = j('idle-st-idle-baseline/summary.json');
if (idle) L.push(`### idle-baseline — no load (worker background only), ${idle.windowMinutes} min (MEASURED)`, '', `SQL/min toplevel=${idle.sql.topLevelCallsPerMin}, nested=${idle.sql.nestedInsideDefinerFunctionsPerMin}; CPU % of one core: ${Object.entries(idle.cpuFromCgroupPctOfOneCore).map(([k, v]) => `${k.replace('costaudit-', '')}=${v}`).join(', ')}; host contention ${idle.hostContention?.totalCpuPctAvg}. Subtract from the windows below for the polling share.`, '');
for (const w of windows) L.push(md(`analysis-${w}.md`), '');
const web = j('web/web-summary.json');
if (web) L.push('## Real web client (Playwright, MEASURED; hidden = emulated visibility)', '', md('web/web-summary.md'), '');
const fl = j('flutter/flutter-summary.json');
if (fl) L.push('## Real Flutter client (Android emulator, MEASURED from the API side)', '', md('flutter/flutter-summary.md'), '');
L.push('## Host conditions per window', '', '```', md('host-conditions.log').split('\n').filter((l) => /^## |hostFreeMB|heavy-|queue=/.test(l)).join('\n'), '```');
fs.writeFileSync(path.join(OUT, 'results.md'), L.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, windows: Object.fromEntries(windows.map((w) => [w, j(`analysis-${w}.json`)])), web, flutter: fl }, null, 2));
console.log(`results.md: ${windows.length} server window(s)${web ? ', web' : ''}${fl ? ', flutter' : ''}`);
