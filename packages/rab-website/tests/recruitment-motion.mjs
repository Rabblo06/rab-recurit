import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = 'qa/recruitment-story';
await mkdir(`${out}/frames`, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: `${out}/recording`, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
await page.addInitScript(() => {
  window.storyShifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (!entry.hadRecentInput) window.storyShifts.push(entry.value);
  }).observe({ type: 'layout-shift', buffered: true });
});
await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
const section = page.locator('#connections'),
  stage = page.locator('[data-story-stage]');
const box = await section.boundingBox();
await page.evaluate(
  (y) => scrollTo({ top: y, behavior: 'instant' }),
  box.y - 920,
);
await page.waitForTimeout(300);
const samples = [];
for (let y = box.y - 920; y <= box.y + box.height - 200; y += 35) {
  await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y);
  await page.waitForTimeout(65);
  samples.push(
    await stage.evaluate((el) => ({
      progress: el.style.getPropertyValue('--story-progress'),
      scale: el.style.getPropertyValue('--story-exit-scale'),
      opacity: el.style.getPropertyValue('--story-exit-opacity'),
    })),
  );
}
await stage.scrollIntoViewIfNeeded();
await page.waitForTimeout(1400);
const bounds = await stage.boundingBox();
await page.mouse.move(
  bounds.x + bounds.width * 0.8,
  Math.max(130, bounds.y + bounds.height * 0.45),
);
await page.waitForTimeout(500);
const pointer = await stage.evaluate((el) =>
  Number(el.style.getPropertyValue('--story-pointer-x')),
);
assert(pointer > 0 && pointer <= 1, 'desktop pointer response');
await page.mouse.move(5, 5);
await page.waitForTimeout(500);
assert.equal(
  await stage.evaluate((el) => el.style.getPropertyValue('--story-pointer-x')),
  '0',
);
assert(
  samples.some((s) => Number(s.scale) < 1),
  'exit scale engaged',
);
assert(
  samples.every((s) => !s.scale || Number(s.scale) >= 0.985),
  'bounded exit',
);
const shifts = await page.evaluate(() => window.storyShifts);
const video = page.video();
await context.close();
await video.saveAs(`${out}/motion.webm`);
await writeFile(
  `${out}/inspect-motion.html`,
  '<!doctype html><style>body{margin:0}video{width:1440px;height:900px}</style><video muted preload="auto" src="./motion.webm"></video>',
);
const inspect = await browser.newPage({
  viewport: { width: 1440, height: 900 },
});
await inspect.goto(
  new URL(`../${out}/inspect-motion.html`, import.meta.url).href,
);
await inspect.waitForFunction(
  () => document.querySelector('video').readyState >= 2,
);
const duration = await inspect.locator('video').evaluate((v) => v.duration);
for (let i = 0; i < 20; i++) {
  await inspect.locator('video').evaluate(
    (v, t) =>
      new Promise((resolve) => {
        v.addEventListener('seeked', resolve, { once: true });
        v.currentTime = t;
      }),
    Math.max(0.01, (i * duration) / 20),
  );
  await inspect.screenshot({
    path: `${out}/frames/${String(i).padStart(2, '0')}.png`,
  });
}
await writeFile(
  `${out}/motion-results.json`,
  JSON.stringify(
    {
      duration,
      pointer,
      layoutShiftSum: shifts.reduce((a, b) => a + b, 0),
      samples,
    },
    null,
    2,
  ),
);
await browser.close();
console.log(
  'PASS: desktop pointer/reset, bounded scroll/exit, recorded motion and 20 frames.',
);
