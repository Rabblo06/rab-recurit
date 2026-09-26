import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: 'qa/scroll', size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const bottom = await page.evaluate(
  () => document.documentElement.scrollHeight - innerHeight,
);
for (let y = 0; y <= bottom + 70; y += 70) {
  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: 'instant' }),
    y,
  );
  await page.waitForTimeout(85);
}
await page.waitForTimeout(900);
await page.screenshot({ path: 'qa/desktop-footer.png' });
const video = page.video();
await context.close();
await video.saveAs('qa/full-scroll.webm');
const inspect = await browser.newPage({
  viewport: { width: 1440, height: 900 },
});
const html = `<!doctype html><style>body{margin:0;background:#fff}video{width:1440px;height:900px}</style><video muted preload="auto" src="./full-scroll.webm"></video>`;
await writeFile('qa/inspect-video.html', html);
await inspect.goto(new URL('../qa/inspect-video.html', import.meta.url).href);
await inspect.waitForFunction(
  () => document.querySelector('video').readyState >= 2,
);
const duration = await inspect.locator('video').evaluate((v) => v.duration);
await mkdir('qa/frames', { recursive: true });
for (let i = 0; i < 16; i++) {
  const t = Math.min(duration - 0.1, (i * duration) / 16);
  await inspect.locator('video').evaluate(
    (v, t) =>
      new Promise((resolve) => {
        v.addEventListener('seeked', resolve, { once: true });
        v.currentTime = Math.max(0.01, t);
      }),
    t,
  );
  await inspect.screenshot({
    path: `qa/frames/frame-${String(i).padStart(2, '0')}.png`,
  });
}
await writeFile(
  'qa/scroll-metadata.json',
  JSON.stringify(
    {
      duration,
      frames: 16,
      scrollHeight: bottom + 900,
      viewport: { width: 1440, height: 900 },
    },
    null,
    2,
  ),
);
await browser.close();
