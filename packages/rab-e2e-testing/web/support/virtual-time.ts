import type { Page } from '@playwright/test';

/**
 * Virtual time for animation-timing specs (2026-10-29).
 *
 * The motion specs sample rendered values every animation frame and assert durations ("the dock enters in ~220ms",
 * "the drawer closes in ~220ms"). Against the wall clock those numbers depend on the machine: a 2-vCPU CI runner with
 * the Vite dev server compiling alongside drops frames, so the same animation measured 149ms one run and 406ms the
 * next. Here time is driven instead: Playwright's clock (page.clock) replaces Date, timers, requestAnimationFrame and
 * performance.now, and a measurement runs with that clock paused and advanced by exactly the window under test.
 * However slow the machine, every animation frame happens and happens at its exact virtual time.
 *
 * What drives each kind of animation in rab-front, and how it is put on the virtual clock:
 *  - Framer Motion's JS frameloop (x/y/width/scale, layoutId springs, `animate()` count-ups): requestAnimationFrame +
 *    performance.now (framer-motion 11 `frameloop/batcher`, `sync-time`) — controlled by page.clock as is.
 *  - Framer Motion hands `opacity`/`transform`/`filter`/`clipPath` to the Web Animations API when
 *    `Element.prototype` owns `animate` (`supportsWaapi`). WAAPI runs on the browser's document timeline, which no
 *    fake clock reaches. The init script below hides `animate` from that one feature check (it stays callable on
 *    HTMLElement/SVGElement), so Framer runs those values on its JS frameloop — same keyframes, duration, easing and
 *    delay from `shared/motion.ts`, now sampled frame by frame on the virtual clock.
 *  - Plain CSS transitions/animations (the page-header `.tab-strip-indicator`): while time is frozen they are paused
 *    and seeked every virtual frame to `virtualNow − virtualStart` through `document.getAnimations()`, and released
 *    (finished or resumed) when the measurement ends.
 *
 * Usage: `useVirtualTime(page)` before the first navigation; around a measurement `freezeTime` → start sampling →
 * trigger → `advance(ms)` → read samples → `releaseTime`. Between measurements the clock runs in real time, so the
 * rest of a spec (expect polling, data loading, toasts) behaves as before.
 */

/** Fixed `Date.now()` per page (crewflow fixtures pin it), re-applied after a freeze. */
const fixedDates = new WeakMap<Page, number>();

/** Pin `Date.now()` (keeps timers running) and remember it so freeze/release cycles restore it. */
export async function setFixedDate(page: Page, date: Date): Promise<void> {
  fixedDates.set(page, date.getTime());
  await page.clock.setFixedTime(date);
}

/** Install the fake clock and the animation bridge. Call before the first `page.goto`. */
export async function useVirtualTime(page: Page): Promise<void> {
  await page.clock.install();
  const fixed = fixedDates.get(page);
  if (fixed != null) await page.clock.setFixedTime(fixed); // install() would otherwise un-pin a date set earlier
  await page.addInitScript(bridge);
}

/** Stop time: no timer, frame or animation advances until `advance`. Safe to call again after a navigation. */
export async function freezeTime(page: Page): Promise<void> {
  const t = fixedDates.get(page) ?? (await page.evaluate(() => Date.now()));
  // Pinning the date first makes pauseAt(t) consume exactly 0 ms of virtual time.
  await page.clock.setFixedTime(t);
  await page.clock.pauseAt(t);
  // Start every window on a frame boundary (page.clock fires animation frames every 16ms of virtual time), so a
  // measurement has the same frame phase on every run.
  const ticks = await page.evaluate(() => performance.now());
  await page.clock.runFor((16 - (ticks % 16)) % 16);
  await page.evaluate(() => (window as unknown as VirtualTimeWindow).__vt?.hold());
}

/** Advance virtual time by `ms`, firing every timer and every 16ms animation frame on the way. */
export async function advance(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
}

/**
 * Advance one 16ms frame at a time until `check` holds (e.g. data that arrives over the network has been painted —
 * network responses take real time, and their delivery needs timers to run), up to `maxMs` of virtual time. A window
 * that follows is anchored on that moment, not on how long the response took on this machine.
 */
export async function advanceUntil(page: Page, check: () => boolean | Promise<boolean>, maxMs = 10_000): Promise<number> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 16) {
    if (await check()) return elapsed;
    await page.clock.runFor(16);
  }
  throw new Error(`advanceUntil: condition not met within ${maxMs}ms of virtual time`);
}

/** Let time run in real time again (CSS animations resume or finish; a pinned date is restored). */
export async function releaseTime(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as VirtualTimeWindow).__vt?.release());
  await page.clock.resume();
  const fixed = fixedDates.get(page);
  if (fixed != null) await page.clock.setFixedTime(fixed);
  else await page.clock.setSystemTime(await page.evaluate(() => Date.now()));
}

interface VirtualTimeWindow { __vt?: { hold: () => void; release: () => void } }

/** Init script (runs in every document before the app): see the header comment. */
function bridge() {
  const w = window as unknown as VirtualTimeWindow;
  if (w.__vt) return;

  // 1. Framer Motion's WAAPI feature check is `Object.hasOwnProperty.call(Element.prototype, 'animate')`.
  const animate = Element.prototype.animate;
  if (Object.prototype.hasOwnProperty.call(Element.prototype, 'animate')) {
    delete (Element.prototype as { animate?: unknown }).animate;
    for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
      Object.defineProperty(proto, 'animate', { value: animate, writable: true, configurable: true });
    }
  }

  // 2. CSS transitions/animations follow the virtual clock while held.
  const held = new Map<Animation, number>(); // animation -> virtual start (ms, performance.now() under page.clock)
  let holding = false;
  const endOf = (a: Animation) => Number(a.effect?.getComputedTiming().endTime ?? 0);
  const seek = (a: Animation, now: number) => {
    a.currentTime = Math.min(Math.max(0, now - held.get(a)!), endOf(a));
  };
  const take = (a: Animation, start: number) => {
    held.set(a, start);
    a.pause();
    seek(a, performance.now());
  };
  const frame = () => {
    if (!holding) return;
    const now = performance.now();
    for (const a of document.getAnimations()) {
      if (held.has(a)) seek(a, now);
      else if (a.playState === 'running') take(a, now); // started during this frozen window: t = 0 now
    }
    requestAnimationFrame(frame);
  };
  w.__vt = {
    hold() {
      if (holding) return;
      holding = true;
      const now = performance.now();
      // Already running in real time when the window opened: continue from where they are.
      for (const a of document.getAnimations()) if (a.playState === 'running') take(a, now - Number(a.currentTime ?? 0));
      requestAnimationFrame(frame);
    },
    release() {
      holding = false;
      for (const a of held.keys()) {
        if (a.playState === 'idle') continue;
        if (Number(a.currentTime ?? 0) >= endOf(a)) a.finish();
        else a.play();
      }
      held.clear();
    },
  };
}
