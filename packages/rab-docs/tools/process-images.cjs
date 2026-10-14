// Optimises captured screenshots into the WebP files the pages reference.
//   - images/web/**/<name>.png        → images/web/**/<name>.webp   (max 2400 px wide, PNG removed)
//   - mobile captures (mapping file)  → images/mobile/<name>.webp   (max 720 px wide)
//   - selected Flutter goldens        → images/mobile/<name>.webp   (native size)
// Usage (from the repo root):  FFMPEG=/path/to/ffmpeg node packages/rab-docs/tools/process-images.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const toWebp = (src, dst, maxW) => {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  ff(['-i', src, '-vf', `scale='min(${maxW},iw)':-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', dst]);
};
const report = { web: 0, mobile: 0, goldens: 0, missingSources: [] };

// Web: convert every PNG in place.
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.png')) {
      toWebp(p, p.replace(/\.png$/, '.webp'), 2400);
      fs.unlinkSync(p);
      report.web++;
    }
  }
})(path.join(root, 'images', 'web'));

// Mobile: explicit mapping from capture file to published name, so page references stay stable.
const mapFile = path.join(__dirname, 'mobile-image-map.json');
if (fs.existsSync(mapFile)) {
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  for (const [published, source] of Object.entries(map.captures || {})) {
    const src = path.join(root, 'images', 'mobile', 'raw', source);
    if (!fs.existsSync(src)) { report.missingSources.push(source); continue; }
    toWebp(src, path.join(root, 'images', 'mobile', `${published}.webp`), 720);
    report.mobile++;
  }
  for (const [published, golden] of Object.entries(map.goldens || {})) {
    const src = path.join(repo, 'packages', 'rab-mobile', 'test', 'goldens', golden);
    if (!fs.existsSync(src)) { report.missingSources.push(golden); continue; }
    toWebp(src, path.join(root, 'images', 'mobile', `${published}.webp`), 720);
    report.goldens++;
  }
}
console.log(JSON.stringify(report, null, 1));
