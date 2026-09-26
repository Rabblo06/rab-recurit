import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.QA_URL || 'http://localhost:3100';
await mkdir('qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [],
  errors = [];
for (const [name, width, height] of [
  ['desktop', 1440, 900],
  ['wide', 1920, 1080],
  ['tablet', 1024, 900],
  ['mobile', 390, 844],
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo:
      name === 'desktop'
        ? { dir: 'qa/video', size: { width: 1440, height: 900 } }
        : undefined,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(950);
  await page.screenshot({ path: `qa/${name}-hero.png` });
  const sections = page.locator('main > section');
  for (let i = 0; i < (await sections.count()); i++) {
    await sections.nth(i).scrollIntoViewIfNeeded();
    await page.waitForTimeout(850);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} overflow section ${i}`,
    );
    if (name === 'desktop' || name === 'mobile')
      await page.screenshot({
        path: `qa/${name}-section-${String(i).padStart(2, '0')}.png`,
      });
  }
  await page.screenshot({ path: `qa/${name}-full.png`, fullPage: true });
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
    .analyze();
  results.push({
    name,
    viewport: { width, height },
    violations: scan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  });
  if (name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: 'qa/mobile-menu.png' });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      assert(
        await page.evaluate(
          () => !!document.activeElement?.closest('[role="dialog"]'),
        ),
        'focus escaped mobile sheet',
      );
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert(
      await page
        .getByRole('button', { name: 'Open navigation' })
        .evaluate((el) => el === document.activeElement),
      'menu focus restoration',
    );
  }
  await page.goto(`${base}/jobs`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.job-card').count(), 3);
  await page.locator('.job-card').first().click();
  await page.waitForURL('**/contact?interest=candidate');
  assert(
    await page
      .getByRole('radio', { name: 'Find work', exact: true })
      .isChecked(),
  );
  assert.equal(await page.locator('a[href^="mailto:"]').count(), 1);
  await page.screenshot({ path: `qa/${name}-contact.png` });
  const contactScan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
    .analyze();
  results.push({
    name: `${name}-contact`,
    violations: contactScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  });
  await context.close();
}
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
await page.goto(base, { waitUntil: 'networkidle' });
for (const selector of [
  '.marquee-track',
  '.hero h1 span',
  '.hero-glow',
  '.reveal',
])
  assert.equal(
    await page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
await page.locator('#approach').scrollIntoViewIfNeeded();
assert.equal(
  await page
    .locator('.flow-reveal')
    .last()
    .evaluate((el) => getComputedStyle(el).opacity),
  '1',
);
await page.screenshot({ path: 'qa/mobile-reduced-motion.png' });
results.push({ name: 'reduced-motion', passed: true });
await context.close();
const noJs = await browser.newContext({
  javaScriptEnabled: false,
  viewport: { width: 1440, height: 900 },
});
const fallback = await noJs.newPage();
await fallback.goto(base);
assert.equal(
  await fallback.locator('h1').innerText(),
  'Great people.\nNew possibilities.',
);
assert.equal(
  await fallback
    .locator('.flow-reveal')
    .last()
    .evaluate((el) => getComputedStyle(el).opacity),
  '1',
);
await noJs.close();
await browser.close();
await writeFile(
  'qa/results.json',
  JSON.stringify({ results, errors, noJsContentVisible: true }, null, 2),
);
assert.equal(errors.length, 0, JSON.stringify(errors));
assert.equal(
  results.flatMap((r) => r.violations || []).length,
  0,
  'Accessibility violations: see qa/results.json',
);
console.log(
  'PASS: four viewports, all sections, routes, candidate contact, focus trap/restore, reduced motion, no-JS content and axe checks.',
);
