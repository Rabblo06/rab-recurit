import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('qa/recruitment-story', { recursive: true });
const results = [],
  errors = [];
for (const [width, height] of [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [768, 1024],
  [430, 932],
  [390, 844],
  [375, 812],
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: width < 1024,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (['warning', 'error'].includes(m.type())) errors.push(m.text());
  });
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  const section = page.locator('#connections'),
    stage = page.locator('[data-story-stage]');
  await section.scrollIntoViewIfNeeded();
  for (const entry of await section.locator('[data-story-entry]').all()) {
    await entry.scrollIntoViewIfNeeded();
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(1700);
  await stage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(550);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `overflow ${width}`,
  );
  const image = section.locator('img');
  await image.evaluate((img) => img.decode());
  assert.equal(
    await image.evaluate((img) => getComputedStyle(img).objectFit),
    'cover',
  );
  assert(await image.evaluate((img) => img.naturalWidth > 0));
  const cards = await section
    .locator('[data-story-stage] [data-story-entry]')
    .evaluateAll((nodes) =>
      nodes.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          opacity: getComputedStyle(el).opacity,
        };
      }),
    );
  assert(
    cards.every((r) => r.left >= -1 && r.right <= width + 1),
    `card bounds ${width}`,
  );
  if (width < 768)
    assert(
      cards.every((r, i) => i === 0 || r.top >= cards[i - 1].bottom - 1),
      `mobile card order ${width}`,
    );
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, Math.max(100, box.y + 150));
  await page.waitForTimeout(500);
  const pointer = await stage.evaluate((el) =>
    el.style.getPropertyValue('--story-pointer-x'),
  );
  if (width < 1024)
    assert(!pointer || pointer === '0', `touch pointer ${width}`);
  await page.screenshot({ path: `qa/recruitment-story/${width}-viewport.png` });
  await section.screenshot({
    path: `qa/recruitment-story/${width}-section.png`,
    style: '.site-header, .skip-link { visibility: hidden !important; }',
  });
  const axe = await new AxeBuilder({ page })
    .include('#connections')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
    .analyze();
  results.push({
    width,
    height,
    cards,
    pointer,
    violations: axe.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  });
  const nav = page.locator(width > 800 ? '.nav-pill' : '.menu-trigger');
  const navBox = await nav.boundingBox();
  assert(
    await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.site-header'),
      { x: navBox.x + navBox.width / 2, y: navBox.y + navBox.height / 2 },
    ),
    'nav layering',
  );
  await section.getByRole('link', { name: 'IT & media', exact: true }).click();
  await page.waitForURL('**/contact?sector=IT%20%26%20media');
  await context.close();
}
for (const mode of ['reduce', 'no-js']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: mode === 'reduce' ? 'reduce' : 'no-preference',
    javaScriptEnabled: mode !== 'no-js',
  });
  const page = await context.newPage();
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.locator('#connections').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  assert(
    await page
      .locator('#connections [data-story-entry]')
      .evaluateAll((nodes) =>
        nodes.every((el) => getComputedStyle(el).opacity === '1'),
      ),
    `${mode} visibility`,
  );
  if (mode === 'reduce') {
    const stage = page.locator('[data-story-stage]');
    await page.mouse.move(900, 500);
    assert.equal(
      await stage.evaluate((el) =>
        el.style.getPropertyValue('--story-pointer-x'),
      ),
      '0',
    );
  }
  await page
    .locator('#connections')
    .screenshot({ path: `qa/recruitment-story/${mode}.png` });
  await context.close();
}
await browser.close();
await writeFile(
  'qa/recruitment-story/results.json',
  JSON.stringify({ results, errors, reducedMotion: true, noJs: true }, null, 2),
);
assert.equal(errors.length, 0, JSON.stringify(errors));
assert.equal(
  results.flatMap((r) => r.violations).length,
  0,
  'See recruitment-story/results.json',
);
console.log(
  'PASS: eight viewports, local photo, card bounds/order, nav layering, links, touch isolation, reduced motion, no-JS and axe.',
);
