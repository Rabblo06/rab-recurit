// Renders the docs brand assets (navbar wordmarks, favicon) from the committed Crewflow mark.
// Source mark: packages/rab-readme/crewflow-logo-{light,dark}.png (derived from packages/rab-mobile/image/image.png).
// Run from the repo root:  node packages/crewflow-docs/tools/build-brand.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '../../..');
const out = path.resolve(__dirname, '../images/brand');
fs.mkdirSync(out, { recursive: true });

const dataUri = (file) => 'data:image/png;base64,' + fs.readFileSync(path.join(repo, file)).toString('base64');

const wordmark = (mark, color) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@600&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:transparent}
.w{display:inline-flex;align-items:center;gap:14px;padding:4px 6px;font:600 44px/1 Inter,system-ui,sans-serif;letter-spacing:-0.02em;color:${color}}
.w img{width:56px;height:56px}</style></head>
<body><div class="w" id="w"><img src="${mark}" alt=""><span>Crewflow</span></div></body></html>`;

const favicon = (mark) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
.f{width:256px;height:256px;border-radius:56px;background:#ffffff;display:flex;align-items:center;justify-content:center}
.f img{width:200px;height:200px}</style></head><body><div class="f" id="w"><img src="${mark}" alt=""></div></body></html>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const jobs = [
    ['logo-light.png', wordmark(dataUri('packages/rab-readme/crewflow-logo-light.png'), '#1c1917')],
    ['logo-dark.png', wordmark(dataUri('packages/rab-readme/crewflow-logo-dark.png'), '#f5f5f4')],
    ['favicon.png', favicon(dataUri('packages/rab-readme/crewflow-logo-light.png'))],
  ];
  for (const [name, html] of jobs) {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#w').screenshot({ path: path.join(out, name), omitBackground: true });
    console.log('wrote', name);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
