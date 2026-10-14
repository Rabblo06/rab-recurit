// Screenshots the running docs preview (mint dev) at desktop, tablet and phone widths, in light and dark,
// and checks each page for horizontal overflow, broken images, unplayable videos and page errors.
// Usage: start `mint dev --port 3333`, then:  node packages/rab-docs/tools/screenshot-docs.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.DOCS_URL || 'http://localhost:3333';
const OUT = process.env.OUT || path.resolve(__dirname, '../internal/preview');
fs.mkdirSync(OUT, { recursive: true });

const PAGES = (process.env.PAGES || [
  '/', '/getting-started/user-roles', '/shifts/overview', '/shifts/creating-shifts', '/shifts/confirming-offers',
  '/attendance/clock-in-and-out', '/mobile/offers', '/payroll/overview', '/security/data-isolation',
  '/developers/introduction', '/developers/api-reference/endpoints',
].join(',')).split(',');
const VIEWPORTS = [['desktop', 1440, 900], ['tablet', 834, 1112], ['phone', 390, 844]];
const SCHEMES = (process.env.SCHEMES || 'light,dark').split(',');
const SHOTS = new Set((process.env.SHOT || 'desktop-light,desktop-dark,phone-light,tablet-light').split(','));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  for (const scheme of SCHEMES) {
    for (const [vpName, width, height] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 });
      for (const route of PAGES) {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 90000 }).catch((e) => errors.push('goto: ' + e.message));
        await page.waitForTimeout(1200);
        const info = await page.evaluate(async () => {
          // Load lazy images before checking them.
          for (const img of document.images) img.loading = 'eager';
          window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 600)); window.scrollTo(0, 0);
          await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
          const videos = [...document.querySelectorAll('video')];
          return {
            title: document.title,
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
            brokenImages: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')),
            videos: videos.map((v) => ({ src: v.currentSrc || v.querySelector('source')?.src, ready: v.readyState, error: v.error?.code || null })),
            h1: document.querySelector('h1')?.textContent?.trim(),
          };
        });
        const key = `${vpName}-${scheme}`;
        if (SHOTS.has(key)) {
          const name = `${route === '/' ? 'home' : route.slice(1).replace(/\//g, '__')}--${key}.png`;
          await page.screenshot({ path: path.join(OUT, name), fullPage: vpName !== 'desktop' ? false : false });
          info.screenshot = name;
        }
        results.push({ route, viewport: vpName, scheme, ...info, errors });
        await page.close();
      }
      await ctx.close();
    }
  }
  await browser.close();
  const issues = results.filter((r) => r.overflowX > 1 || r.brokenImages.length || r.errors.length || r.videos.some((v) => v.error));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ checked: results.length, issues: issues.map((r) => ({ route: r.route, vp: r.viewport, scheme: r.scheme, overflowX: r.overflowX, brokenImages: r.brokenImages.length, errors: r.errors.slice(0, 2), videoErrors: r.videos.filter((v) => v.error) })) }, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
