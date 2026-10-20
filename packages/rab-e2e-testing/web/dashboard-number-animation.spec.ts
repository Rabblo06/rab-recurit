import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fixtures, type FixtureOptions } from './support/crewflow-fixtures';

/**
 * Dashboard number & chart animation (2026-10-20) — FIXTURE-based browser proof on the real Dashboard route (isolated
 * Vite :5174, deterministic API fixtures; nothing touches the development API or database). The page's own painted
 * values are sampled every animation frame (requestAnimationFrame), from the moment each element first appears, so the
 * evidence is what the user sees — no animation is disabled or fast-forwarded. Videos are recorded at normal speed.
 */
const OUT = path.resolve(__dirname, '.qa-shots/dashboard-numbers-2026-10-20');
test.use({ viewport: { width: 1440, height: 900 }, video: { mode: 'on', size: { width: 1440, height: 900 } } });
// MOTION_BASE_URL=http://127.0.0.1:5175 runs the same proof against a production build (vite preview): realistic timing.
// The default (dev server, React Strict Mode) proves the effects survive Strict Mode's mount/cleanup/re-mount.
if (process.env.MOTION_BASE_URL) test.use({ baseURL: process.env.MOTION_BASE_URL });

type Kind = 'text' | 'scaleX' | 'scaleY';
const TARGETS: Record<string, [string, Kind]> = {
  staff: ['.dash-counts > div:nth-child(1) dd', 'text'],
  people: ['.dash-counts > div:nth-child(2) dd', 'text'],
  venues: ['.dash-counts > div:nth-child(3) dd', 'text'],
  hours: ['.dash-hours .dash-big > span[data-value]', 'text'],
  accepted: ['.dash-strip-item:nth-child(2) .dash-strip-value', 'text'],
  acceptedFill: ['.dash-strip-item:nth-child(2) .dash-strip-fill', 'scaleX'],
  hourBar: ['.dash-bars .dash-bar-col:nth-child(2) .dash-bar', 'scaleY'],
  venueBar: ['.dash-hbars li:first-child .dash-hbar', 'scaleX'],
  readiness: ['.dash-readiness-pct > span[data-value]', 'text'],
  pipelineTotal: ['.dash-pipeline .dash-big > span[data-value]', 'text'],
};

/** Installs a per-frame recorder before any app code runs. `__rec[name]` = [msSinceFirstSeen, value][] (reset via __recReset). */
async function installRecorder(page: Page) {
  await page.addInitScript((targets) => {
    const w = window as unknown as { __rec: Record<string, Array<[number, string]>>; __first: Record<string, number>; __recReset: () => void };
    w.__rec = {}; w.__first = {};
    w.__recReset = () => { w.__rec = {}; w.__first = {}; };
    const read = (el: Element, kind: string) => {
      if (kind === 'text') return ((el.querySelector('[data-animating]') ?? el).textContent ?? '').trim();
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return (kind === 'scaleX' ? m.a : m.d).toFixed(3);
    };
    const tick = () => {
      const now = performance.now();
      for (const [name, [sel, kind]] of Object.entries(targets)) {
        const el = document.querySelector(sel);
        if (!el) continue;
        w.__first[name] ??= now;
        (w.__rec[name] ??= []).push([Math.round(now - w.__first[name]!), read(el, kind)]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, TARGETS);
}
const rec = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __rec: Record<string, Array<[number, string]>> }).__rec[n] ?? [], name);
const num = (t: string) => Number(t.replace(/[^0-9.]/g, ''));

/** Asserts a visible count-up: starts at/near 0, ≥2 distinct intermediate values, monotonic, exact final, settles in window. */
function expectCountUp(all: Array<[number, string]>, final: string, { maxMs = 1800, minMs = 600 } = {}) {
  // Time 0 = the first painted NUMBER (a loading "–" before the data arrives is not part of the animation).
  const firstNumeric = all.findIndex(([, v]) => v !== '–');
  const samples = all.slice(firstNumeric).map(([t, v]) => [t - all[firstNumeric]![0], v] as [number, string]);
  const values = samples.map(([, v]) => v);
  const nums = values.map(num);
  const finalNum = num(final);
  const intermediates = [...new Set(nums.filter((n) => n > 0 && n < finalNum))];
  const settledAt = samples.find(([, v]) => v === final)?.[0];
  expect(nums[0]).toBeLessThan(finalNum);
  expect(intermediates.length).toBeGreaterThanOrEqual(2);
  expect(nums.every((n, i) => i === 0 || n >= nums[i - 1]!)).toBe(true);
  expect(values.at(-1)).toBe(final);
  expect(settledAt).toBeGreaterThanOrEqual(minMs);
  expect(settledAt).toBeLessThanOrEqual(maxMs);
  return { intermediates, settledAt };
}
function expectGrows(samples: Array<[number, string]>, final: number) {
  const v = samples.map(([, s]) => Number(s));
  expect(v[0]).toBeLessThan(0.25); // the first painted frame (≈16–35ms in) is near the baseline
  expect(new Set(v.filter((x) => x > 0.05 && x < final - 0.02)).size).toBeGreaterThanOrEqual(3);
  expect(v.every((x, i) => i === 0 || x >= v[i - 1]! - 0.001)).toBe(true);
  expect(Math.abs(v.at(-1)! - final)).toBeLessThan(0.005);
}
async function load(page: Page, opts: FixtureOptions) {
  await installRecorder(page);
  const state = await fixtures(page, opts);
  // Warm the app's code into this browser context first (the unbundled dev server otherwise parses hundreds of modules
  // while the dashboard animates, which skips frames). Data is not touched: Help makes no dashboard requests.
  await page.goto('/help');
  await page.getByRole('heading', { name: 'How can we help?' }).waitFor();
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as unknown as { __recReset: () => void }).__recReset());
  return state;
}
/**
 * Frame evidence without disturbing the animation: Chrome's screencast streams painted frames with wall-clock
 * timestamps (a page.screenshot during the animation stalls rendering). Returns a saver that writes the frames nearest
 * to the requested offsets from `t0` (ms since epoch).
 */
async function screencast(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const frames: Array<{ at: number; data: string }> = [];
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ at: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, data: f.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  return async (name: string, t0: number, offsets: number[]) => {
    await cdp.send('Page.stopScreencast');
    const fs = await import('node:fs');
    fs.mkdirSync(OUT, { recursive: true });
    return offsets.map((ms) => {
      const best = frames.reduce((p, f) => (Math.abs(f.at - (t0 + ms)) < Math.abs(p.at - (t0 + ms)) ? f : p), frames[0]!);
      fs.writeFileSync(path.join(OUT, `${name}-${String(ms).padStart(4, '0')}ms.jpg`), Buffer.from(best.data, 'base64'));
      return `${ms}ms→${Math.round(best.at - t0)}ms`;
    });
  };
}

test('MILESTONE: the real Staff counter visibly counts up to its value (cold load, delayed data) — plus intermediate frames', async ({ page }) => {
  await load(page, { populated: true, summaryDelayMs: 800 });
  const save = await screencast(page);
  await page.goto('/');
  // t0 = the first painted NUMBER (the counter shows "–" while its delayed data is in flight).
  await page.waitForFunction((sel) => { const t = document.querySelector(sel)?.textContent?.trim(); return !!t && t !== '–'; }, TARGETS.staff[0], { polling: 'raf' });
  const t0 = Date.now();
  await page.waitForTimeout(2000);
  const shots = await save('cold', t0, [0, 300, 700, 1500]);
  const staff = await rec(page, 'staff');
  const r = expectCountUp(staff, '64');
  console.log(`staff: ${staff.length} frames, intermediates ${JSON.stringify(r.intermediates.slice(0, 12))}…, settled at ${r.settledAt}ms; shots ${shots.join(', ')}`);
  for (const name of ['people', 'venues']) expectCountUp(await rec(page, name), name === 'people' ? '15' : '12');
});

test('populated widgets: hours decimals, strip % + fill, bars and venue bars grow, readiness and pipeline count', async ({ page }) => {
  await load(page, { populated: true });
  await page.goto('/');
  await page.waitForTimeout(2500);
  const hours = expectCountUp(await rec(page, 'hours'), '6.6');
  expect((await rec(page, 'hours')).every(([, v]) => /^\d+\.\d$/.test(v))).toBe(true);
  expectCountUp(await rec(page, 'accepted'), '33%');
  expectGrows(await rec(page, 'acceptedFill'), 1);
  expectGrows(await rec(page, 'hourBar'), 1); // 6.6 h on each worked day = the tallest bar
  expectGrows(await rec(page, 'venueBar'), 1);
  expectCountUp(await rec(page, 'readiness'), '29%');
  expectCountUp(await rec(page, 'pipelineTotal'), '20');
  console.log(`hours settled at ${hours.settledAt}ms through ${JSON.stringify(hours.intermediates.slice(0, 10))}`);
  await page.screenshot({ path: path.join(OUT, 'populated-final.png') });
});

test('real-data shape: Staff 5 counts up; unavailable stays –; 0.0 h and no shift stay honest; 100% confirmed fills', async ({ page }) => {
  await load(page, { realShape: true });
  await page.goto('/');
  const save = await screencast(page);
  await page.locator(TARGETS.staff[0]).waitFor();
  const t0 = Date.now();
  await page.waitForTimeout(1900);
  console.log(`real-shape frames ${(await save('real-shape', t0, [0, 300, 700, 1500])).join(', ')}`);
  const staff = await rec(page, 'staff');
  const nums = staff.map(([, v]) => num(v));
  expect(nums[0]).toBe(0);
  expect(new Set(nums.filter((n) => n > 0 && n < 5)).size).toBeGreaterThanOrEqual(2); // 1…4 painted on the way to 5
  expect(staff.at(-1)![1]).toBe('5');
  expect(new Set((await rec(page, 'people')).map(([, v]) => v))).toEqual(new Set(['–'])); // never animated, never 0
  expect(new Set((await rec(page, 'hours')).map(([, v]) => v))).toEqual(new Set(['0.0'])); // zero is zero — no fake motion
  await expect(page.getByText('No upcoming shifts in the next 14 days.')).toBeVisible();
  await expect(page.locator('.dash-strip-item:nth-child(3) .dash-strip-value')).toHaveText('100%');
  await expect(page.locator('.dash-strip-item:nth-child(1) .dash-strip-pill')).toHaveClass(/is-empty/); // a real 0% is an empty track
  await page.screenshot({ path: path.join(OUT, 'real-shape-final.png') });
});

test('deliberate cached return (Users → Dashboard, Offers → Dashboard) replays the count-up without refetch delay', async ({ page }) => {
  const state = await load(page, { populated: true });
  await page.goto('/');
  await page.waitForTimeout(2000);
  for (const from of ['Users', 'Offers']) {
    await page.getByRole('link', { name: from, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${from.toLowerCase()}$`));
    // The router keeps the old page painted until the new one commits — reset only once the old dashboard is gone.
    await expect(page.locator('.dash-counts')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __recReset: () => void }).__recReset());
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await page.waitForTimeout(1900);
    const staff = await rec(page, 'staff');
    console.log(`return from ${from}: first frames ${JSON.stringify(staff.slice(0, 6))}`);
    const r = expectCountUp(staff, '64');
    expectGrows(await rec(page, 'venueBar'), 1);
    console.log(`return from ${from}: staff settled at ${r.settledAt}ms, summary calls so far ${state.summaryCalls}`);
  }
});

test('unchanged polling does not replay; a genuine increase and decrease morph from the shown value; mid-flight retarget', async ({ page }) => {
  const state = await load(page, { populated: true, realtime: true });
  await page.goto('/');
  await page.waitForTimeout(2000);
  const refetch = async () => state.push('offer.sent');
  const calls = state.summaryCalls;
  console.log(`realtime requests before push: ${state.realtimeRequests}`);
  await page.evaluate(() => (window as unknown as { __recReset: () => void }).__recReset());
  await refetch();
  await expect.poll(() => state.summaryCalls).toBeGreaterThan(calls);
  await page.waitForTimeout(900);
  expect(new Set((await rec(page, 'staff')).map(([, v]) => v))).toEqual(new Set(['64'])); // unchanged → no frames but 64

  state.summary = { ...state.summary, staffCount: 70 };
  await page.evaluate(() => (window as unknown as { __recReset: () => void }).__recReset());
  await refetch();
  await page.waitForTimeout(1000);
  const up = (await rec(page, 'staff')).map(([, v]) => num(v));
  expect(Math.min(...up)).toBeGreaterThanOrEqual(64);
  expect(new Set(up.filter((n) => n > 64 && n < 70)).size).toBeGreaterThanOrEqual(2);
  expect(up.at(-1)).toBe(70);

  state.summary = { ...state.summary, staffCount: 50 };
  await page.evaluate(() => (window as unknown as { __recReset: () => void }).__recReset());
  await refetch();
  await page.waitForTimeout(1000);
  const down = (await rec(page, 'staff')).map(([, v]) => num(v));
  expect(Math.max(...down)).toBeLessThanOrEqual(70);
  expect(Math.min(...down)).toBeGreaterThanOrEqual(50);
  expect(down.every((n, i) => i === 0 || n <= down[i - 1]!)).toBe(true);
  expect(down.at(-1)).toBe(50);
});

test('a new target arriving halfway through the reveal continues from the painted value', async ({ page }) => {
  const state = await load(page, { populated: true, summaryDelayMs: 300, realtime: true });
  await page.goto('/');
  await page.waitForFunction(() => !!document.querySelector('.dash-counts > div:nth-child(1) dd [data-animating]'));
  await page.waitForTimeout(350); // roughly a third of the way through the reveal
  state.summary = { ...state.summary, staffCount: 30 };
  state.push('offer.confirmed');
  await page.waitForTimeout(2200);
  const seq = (await rec(page, 'staff')).map(([, v]) => num(v));
  const peak = Math.max(...seq);
  const afterPeak = seq.slice(seq.indexOf(peak));
  expect(peak).toBeGreaterThan(30); // it was on its way to 64 …
  expect(Math.min(...afterPeak)).toBeGreaterThanOrEqual(30); // … then eased down to 30 without dropping to 0
  expect(seq.at(-1)).toBe(30);
});

test('error and permission-restricted metrics are never animated or shown as 0', async ({ page }) => {
  const state = await load(page, { populated: true });
  state.summaryStatus = 500;
  await page.goto('/');
  await page.waitForTimeout(1500);
  for (const name of ['staff', 'people', 'venues']) expect(new Set((await rec(page, name)).map(([, v]) => v))).toEqual(new Set(['–']));
});

test('reduced motion: real values immediately, no count-up frames, everything works', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page, { populated: true, summaryDelayMs: 300 });
  await page.goto('/');
  await page.waitForTimeout(1500);
  const real = (vals: Array<[number, string]>) => new Set(vals.map(([, v]) => v).filter((v) => v !== '–'));
  expect(real(await rec(page, 'staff'))).toEqual(new Set(['64'])); // only the loading dash, then the real value
  expect(real(await rec(page, 'hours'))).toEqual(new Set(['6.6']));
  expect((await rec(page, 'venueBar'))[0]![1]).toBe('1.000');
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.locator('.dash-week-card .dash-card-title')).not.toHaveText(/^19 Oct/);
});

test('rapid route changes settle on exact values; stable card sizes and header during the reveal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page, { populated: true });
  await page.goto('/');
  for (const to of ['Users', 'Dashboard', 'Offers', 'Dashboard', 'Shifts', 'Dashboard']) {
    await page.getByRole('link', { name: to, exact: true }).click();
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  const sizes = () => page.evaluate(() => [...document.querySelectorAll('.dash-card, .topbar')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }).join(','));
  const early = await sizes();
  await page.waitForTimeout(1500);
  expect(await sizes()).toBe(early); // numbers counting and bars growing never resize a card or the header
  await expect(page.locator(TARGETS.staff[0])).toHaveText('64');
  await expect(page.locator('.dash-hours .dash-big > span[data-value]')).toHaveText('6.6');
  expect(errors).toEqual([]);
});

test('performance: frame intervals and long tasks during the full populated reveal (measured, not assumed)', async ({ page }) => {
  await load(page, { populated: true });
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { gaps: number[]; long: number[] } };
    w.__perf = { gaps: [], long: [] };
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__perf.long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
  });
  await page.goto('/');
  await page.locator(TARGETS.staff[0]).waitFor();
  await page.evaluate(() => new Promise<void>((done) => {
    const w = window as unknown as { __perf: { gaps: number[]; long: number[] } };
    w.__perf ??= { gaps: [], long: [] };
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__perf.long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
    let last = performance.now(); const t0 = last;
    const tick = (now: number) => { w.__perf.gaps.push(now - last); last = now; if (now - t0 < 1600) requestAnimationFrame(tick); else done(); };
    requestAnimationFrame(tick);
  }));
  const perf = await page.evaluate(() => (window as unknown as { __perf: { gaps: number[]; long: number[] } }).__perf);
  const sorted = [...perf.gaps].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  console.log(`reveal frames: ${perf.gaps.length} in 1.6s · interval p50 ${q(0.5).toFixed(1)}ms p95 ${q(0.95).toFixed(1)}ms max ${sorted.at(-1)!.toFixed(1)}ms · >50ms frames ${perf.gaps.filter((g) => g > 50).length} · long tasks ${JSON.stringify(perf.long)}`);
  expect(perf.gaps.length).toBeGreaterThan(40);
});

