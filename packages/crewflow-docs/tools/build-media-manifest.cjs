// Builds internal/MEDIA_MANIFEST.md: every published image and video, its origin, size, capture status and the
// pages that use it — plus every referenced file that does not exist yet (capture pending).
// Usage (docs root or repo root):  FFMPEG=/path/to/ffmpeg node packages/crewflow-docs/tools/build-media-manifest.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['tools', 'internal', 'snippets', 'node_modules'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.mdx')) pages.push(p);
  }
})(root);
const usage = new Map();
for (const p of pages) {
  const slug = path.relative(root, p).replace(/\\/g, '/').replace(/\.mdx$/, '');
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/["'`](\/(?:images|videos)\/[^"'`\s)]+)["'`]/g)) {
    if (!usage.has(m[1])) usage.set(m[1], new Set());
    usage.get(m[1]).add(slug);
  }
}

const probe = (file) => {
  let info = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { info = String(e.stderr || ''); }
  return {
    dims: (info.match(/, (\d{2,5}x\d{2,5})/) || [])[1] || '?',
    duration: (info.match(/Duration: 00:(\d\d:\d\d)/) || [])[1] || '',
  };
};

function origin(rel) {
  if (rel.startsWith('images/web/')) return 'Real web console (Vite dev build) + synthetic API fixtures — `tools/web/capture-screens.cjs`';
  if (rel.startsWith('images/mobile/')) {
    const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'mobile-image-map.json'), 'utf8'));
    const name = path.basename(rel, '.webp');
    if (map.goldens?.[name]) return `Real Flutter widget render (golden \`test/goldens/${map.goldens[name]}\`)`;
    if (map.captures?.[name]) return `Real Android app on Pixel 5 emulator + synthetic fixture API — \`images/mobile/raw/${map.captures[name]}\``;
    return 'Mobile';
  }
  if (rel.startsWith('images/getting-started/')) return 'README composite of real UI captures with fictional data (`packages/rab-readme/`)';
  if (rel.startsWith('images/brand/')) return 'Generated from the committed Crewflow mark — `tools/build-brand.cjs`';
  if (rel.startsWith('videos/posters/')) return 'Title card rendered by `tools/compose-videos.cjs`';
  if (rel.startsWith('videos/')) return rel.includes('/mobile/') || rel.includes('/attendance/')
    ? 'Real Android app on the Pixel 5 emulator (emulator screen recorder, synthetic fixture API) + captions — `tools/capture-mobile.sh`, `tools/compose-videos.cjs`'
    : 'Real web console recording (CDP screencast) + captions — `tools/web/record-tutorials.cjs`, `tools/compose-videos.cjs`';
  return '';
}

const rows = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (e.isDirectory()) { if (!/^(images\/mobile\/raw|videos\/raw)/.test(rel)) walk(p); continue; }
    if (!/\.(webp|png|jpg|svg|mp4)$/.test(e.name)) continue;
    const { dims, duration } = probe(p);
    rows.push({ rel, dims, duration, kb: Math.round(fs.statSync(p).size / 1024), origin: origin(rel), used: [...(usage.get('/' + rel) || [])] });
  }
})(path.join(root, 'images'));
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (e.isDirectory()) { if (!rel.startsWith('videos/raw')) walk(p); continue; }
    if (!/\.(webp|mp4)$/.test(e.name)) continue;
    const { dims, duration } = probe(p);
    rows.push({ rel, dims, duration, kb: Math.round(fs.statSync(p).size / 1024), origin: origin(rel), used: [...(usage.get('/' + rel) || [])] });
  }
})(path.join(root, 'videos'));

const pending = [...usage.keys()].filter((r) => !fs.existsSync(path.join(root, r)));
const section = (title, filter) => {
  const list = rows.filter(filter);
  if (!list.length) return '';
  let s = `## ${title} (${list.length})\n\n| File | Dimensions | Length | Size | Origin | Used by |\n| --- | --- | --- | --- | --- | --- |\n`;
  for (const r of list) s += `| \`${r.rel}\` | ${r.dims} | ${r.duration || '—'} | ${r.kb} KB | ${r.origin} | ${r.used.length ? r.used.join(', ') : '_unused_'} |\n`;
  return s + '\n';
};

// Media that pages explicitly mark as not yet captured.
const pendingNotices = [];
for (const p of pages) {
  const slug = path.relative(root, p).replace(/\\/g, '/').replace(/\.mdx$/, '');
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/<CapturePending what="([^"]+)" reason="([^"]+)"/g)) pendingNotices.push({ slug, what: m[1], reason: m[2] });
}
const videos = rows.filter((r) => r.rel.endsWith('.mp4'));
let md = `# Media manifest

Generated by \`tools/build-media-manifest.cjs\` on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand — re-run the script after changing media.

All product imagery shows the **real Crewflow interfaces** populated with **synthetic, fictional data**. Nothing was captured from production, and no real person's data appears. Raw captures (\`images/mobile/raw/\`, \`videos/raw-mobile/\`) are inputs only and are excluded from the published site by \`.mintignore\`.

| Summary | Count |
| --- | --- |
| Published images | ${rows.length - videos.length} |
| Published videos | ${videos.length} (${videos.reduce((n, v) => n + v.kb, 0) > 1024 ? (videos.reduce((n, v) => n + v.kb, 0) / 1024).toFixed(1) + ' MB' : videos.reduce((n, v) => n + v.kb, 0) + ' KB'} total) |
| Referenced but missing | ${pending.length} |
| Marked “not yet captured” on pages | ${pendingNotices.length} |

`;
if (pendingNotices.length) {
  md += `## Not yet captured (${pendingNotices.length})\n\nPages show a labelled “Media not yet captured” notice in place of these. Each needs a real capture before it can be added.\n\n| Page | Media | Blocker and capture task |\n| --- | --- | --- |\n`;
  for (const n of pendingNotices) md += `| ${n.slug} | ${n.what} | ${n.reason} |\n`;
  md += '\n';
}
if (pending.length) {
  md += `## Capture pending (${pending.length})\n\nThese are referenced by pages but do not exist. Pages show a labelled “Media not yet captured” notice instead, never a mock-up.\n\n| File | Used by |\n| --- | --- |\n`;
  for (const p of pending) md += `| \`${p.slice(1)}\` | ${[...usage.get(p)].join(', ')} |\n`;
  md += '\n';
}
md += section('Tutorial videos', (r) => r.rel.endsWith('.mp4'));
const capDir = path.join(__dirname, 'captions');
if (fs.existsSync(capDir)) {
  md += `## Tutorial caption scripts\n\nEach video opens with a 2.4-second title card, then the real recording with these captions (times are seconds into the recording). Source: \`tools/captions/<slug>.json\`.\n\n`;
  for (const f of fs.readdirSync(capDir).filter((x) => x.endsWith('.json')).sort()) {
    const c = JSON.parse(fs.readFileSync(path.join(capDir, f), 'utf8'));
    md += `### ${c.title} — \`${f.replace('.json', '')}\`\n\n_${c.subtitle}_\n\n`;
    for (const cap of c.captions) md += `1. **${cap.start.toFixed(1)}–${cap.end.toFixed(1)} s** — ${cap.text}\n`;
    md += '\n';
  }
}
md += section('Video posters', (r) => r.rel.startsWith('videos/posters/'));
md += section('Web console screenshots', (r) => r.rel.startsWith('images/web/'));
md += section('Mobile app screenshots', (r) => r.rel.startsWith('images/mobile/'));
md += section('Overview and feature imagery', (r) => r.rel.startsWith('images/getting-started/'));
md += section('Brand', (r) => r.rel.startsWith('images/brand/'));

fs.writeFileSync(path.join(root, 'internal', 'MEDIA_MANIFEST.md'), md);
console.log(`MEDIA_MANIFEST.md: ${rows.length} files, ${pending.length} pending`);
