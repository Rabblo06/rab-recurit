// Documentation QA that complements `mint validate` and `mint broken-links`.
//   - every /images/… and /videos/… reference in MDX exists (including JSX props and posters)
//   - every video is H.264 MP4, under Mintlify's 20 MB static-file limit, and decodable
//   - no duplicate page titles; every navigation entry has a file and every page is in navigation
//   - every <img> has non-empty alt text
//   - public pages contain no secret-looking values or internal-only references
// Run from the docs root:  node tools/check-docs.cjs   (set FFMPEG=path to enable deep video checks)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ignore = new Set(['node_modules', 'tools', 'internal', 'snippets', '.mintlify']);
const problems = [];
const warn = [];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.mdx')) acc.push(p);
  }
  return acc;
}

const pages = walk(root);
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const slug = (p) => rel(p).replace(/\.mdx$/, '');

// 1. Media references
const mediaRe = /(?:src|poster)\s*[=:]\s*["'{`]?\s*["'`](\/(?:images|videos)\/[^"'`\s)]+)["'`]/g;
const used = new Map();
for (const page of pages) {
  const text = fs.readFileSync(page, 'utf8');
  for (const m of text.matchAll(mediaRe)) {
    const ref = m[1];
    if (!used.has(ref)) used.set(ref, new Set());
    used.get(ref).add(slug(page));
  }
  // 4. alt text
  for (const m of text.matchAll(/<img\b[^>]*>/g)) {
    if (!/alt="[^"]{4,}"/.test(m[0])) problems.push(`${slug(page)}: <img> without meaningful alt: ${m[0].slice(0, 80)}`);
  }
  for (const m of text.matchAll(/\{\s*src:\s*'[^']+',\s*alt:\s*'([^']*)'/g)) {
    if (m[1].length < 4) problems.push(`${slug(page)}: PhoneShots entry without meaningful alt`);
  }
  // 5. public-content safety
  const secretish = [
    /postgres(?:ql)?:\/\/[^\s`'"]*:[^\s`'"@]+@/i,
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bghp_[A-Za-z0-9]{20,}/,
    /@gmail\.com/i,
    /\.audit\//,
    /docs\/HANDOFF/,
  ];
  for (const re of secretish) if (re.test(text)) problems.push(`${slug(page)}: public page matches sensitive pattern ${re}`);
}
const missing = [...used.keys()].filter((r) => !fs.existsSync(path.join(root, r)));
for (const r of missing) problems.push(`missing media ${r} (used by ${[...used.get(r)].join(', ')})`);

// 2. Videos
const ffmpeg = process.env.FFMPEG;
const videos = [];
(function walkVideos(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('raw')) walkVideos(p); }
    else if (/\.(mp4|webm|mov)$/i.test(e.name)) videos.push(p);
  }
})(path.join(root, 'videos'));
const videoReport = [];
for (const v of videos) {
  const size = fs.statSync(v).size;
  const r = { file: rel(v), mb: +(size / 1048576).toFixed(2) };
  if (!v.endsWith('.mp4')) problems.push(`${r.file}: videos must be .mp4 (H.264) for Safari compatibility`);
  if (size > 20 * 1048576) problems.push(`${r.file}: ${r.mb} MB exceeds Mintlify's 20 MB static file limit`);
  if (!used.has('/' + r.file)) warn.push(`${r.file}: not referenced by any page`);
  if (ffmpeg) {
    let out = '';
    try { execFileSync(ffmpeg, ['-v', 'error', '-i', v, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { out = String(e.stderr || e.message); }
    let info = '';
    try { execFileSync(ffmpeg, ['-hide_banner', '-i', v], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { info = String(e.stderr || ''); }
    r.codec = (info.match(/Video: (\w+)/) || [])[1];
    r.size = (info.match(/, (\d{3,4}x\d{3,4})/) || [])[1];
    r.duration = (info.match(/Duration: ([\d:.]+)/) || [])[1];
    if (r.codec !== 'h264') problems.push(`${r.file}: codec ${r.codec}, expected h264`);
    if (out.trim()) problems.push(`${r.file}: decode errors: ${out.trim().slice(0, 160)}`);
  }
  videoReport.push(r);
}

// 3. Navigation and duplicates
const docs = JSON.parse(fs.readFileSync(path.join(root, 'docs.json'), 'utf8'));
const navPages = [];
(function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (typeof node === 'string') return navPages.push(node);
  if (node && typeof node === 'object') for (const k of ['tabs', 'groups', 'pages']) if (node[k]) collect(node[k]);
})(docs.navigation);
const navSet = new Set(navPages);
const dupNav = navPages.filter((p, i) => navPages.indexOf(p) !== i);
for (const d of dupNav) problems.push(`navigation lists ${d} more than once`);
for (const p of navPages) if (!fs.existsSync(path.join(root, p + '.mdx'))) problems.push(`navigation entry ${p} has no file`);
for (const p of pages) if (!navSet.has(slug(p))) problems.push(`${slug(p)} is not in navigation (would be a hidden, orphan page)`);
const titles = new Map();
for (const p of pages) {
  const t = (fs.readFileSync(p, 'utf8').match(/^title:\s*"([^"]+)"/m) || [])[1];
  if (!t) { problems.push(`${slug(p)}: missing title`); continue; }
  if (!/^description:\s*".{20,}"/m.test(fs.readFileSync(p, 'utf8'))) problems.push(`${slug(p)}: missing or short description`);
  if (titles.has(t)) problems.push(`duplicate title "${t}": ${titles.get(t)} and ${slug(p)}`);
  titles.set(t, slug(p));
}

// Report
const imgs = [...used.keys()].filter((r) => r.startsWith('/images/'));
const vids = [...used.keys()].filter((r) => r.startsWith('/videos/') && r.endsWith('.mp4'));
console.log(JSON.stringify({
  pages: pages.length,
  navigationEntries: navPages.length,
  imageReferences: imgs.length,
  imagesPresent: imgs.filter((r) => fs.existsSync(path.join(root, r))).length,
  videoReferences: vids.length,
  videosPresent: vids.filter((r) => fs.existsSync(path.join(root, r))).length,
  videos: videoReport,
  warnings: warn,
  problems,
}, null, 2));
process.exitCode = problems.length ? 1 : 0;
