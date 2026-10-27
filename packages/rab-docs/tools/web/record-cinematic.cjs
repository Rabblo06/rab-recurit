#!/usr/bin/env node
// Cinematic capture of the REAL Crewflow web console for editorially-zoomed tutorials.
//
//   CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node packages/rab-docs/tools/web/record-cinematic.cjs <slug> --out <dir> [--dpr 2] [--fps 30]
//
// Why a separate recorder: Chrome's screencast (record-tutorials.cjs) always delivers frames at CSS size, so a 1600×900
// layout can never be zoomed without upscaling. Here the page's JavaScript clock is controlled with Playwright's Clock
// API (timers, requestAnimationFrame, performance.now, Date): it is paused, advanced exactly 1/fps per step, and a
// device-pixel screenshot (3200×1800 at --dpr 2) is taken. Capture is slower than real time, but every frame is a true,
// evenly spaced moment of the app's own JavaScript-driven animations (count-ups, growing bars, tooltips, the active-page
// pill) at full resolution. Limit: pure CSS transitions are not on that clock and complete within a frame or two.
// (Chrome's virtual-time policy was tried first; its screenshots stall with this app, so it is not used.)
// The layout, CSS and browser zoom are untouched — the editorial camera is applied later in the HyperFrames composition
// (tools/cinematic/<slug>/).
//
// Every API response comes from the synthetic fixture backend (fixtures.cjs): unknown requests fail with 501 and every
// non-app origin is blocked, so nothing reaches a real API, database, queue or mail server. Fictional data only.
//
// Outputs in <out>/<slug>/: frames/*.jpg (constant fps), frames.json, cues.json (narration lines on the frame clock),
// events.json (pointer/target sidecar: CSS px; frame px = CSS px × dpr), captions.json, run.json.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, APP_ORIGIN, drawer } = require('./common.cjs');
const { generatedPng } = require('./fixtures.cjs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const SLUG = process.argv[2];
const OUT_ROOT = path.resolve(arg('--out', path.join(require('os').tmpdir(), 'rab-docs-cinematic')));
const DPR = Number(arg('--dpr', 2));
const FPS = Number(arg('--fps', 30));
const VIEWPORT = { width: 1600, height: 900 };
const NARRATION_ROOT = path.resolve(__dirname, '..', 'narration', 'build');
const SPEECH_GAP_S = 0.5;

// One readable cursor drawn in the page (headless Chrome has none) and ONE subtle click ring (~320 ms).
const CURSOR_SCRIPT = () => {
  const install = () => {
    if (document.getElementById('__doc-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `#__doc-cursor{position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));}
      .__doc-ring{position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(234,88,12,.85)}`;
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__doc-cursor';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.6 L11.7 15.2 L18.6 15.2 Z" fill="#1d1b19" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const pos = window.__docCursorPos || { x: 1180, y: 640 };
    c.style.transform = `translate(${pos.x}px,${pos.y}px)`;
    window.addEventListener('mousemove', (e) => { window.__docCursorPos = { x: e.clientX, y: e.clientY }; c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__doc-ring'; r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(r);
      // Driven by requestAnimationFrame + performance.now, so it runs on the recorder's stepped clock (320 ms, ease-out).
      const t0 = performance.now();
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / 320); const e2 = 1 - Math.pow(1 - k, 3);
        r.style.transform = `scale(${0.55 + 0.6 * e2})`; r.style.opacity = String(0.95 * (1 - k));
        if (k < 1) requestAnimationFrame(tick); else r.remove();
      };
      requestAnimationFrame(tick);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
};

class SteppedRecorder {
  constructor(slug, page, cdp, narration = slug) {
    this.slug = slug; this.page = page; this.cdp = cdp; this.narration = narration;
    this.dir = path.join(OUT_ROOT, slug);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true });
    this.n = 0; this.frames = []; this.cues = []; this.events = []; this.captions = [];
    this.speechEnd = 0; this.mouse = { x: 1180, y: 640 };
    const seg = path.join(NARRATION_ROOT, narration, 'segments.json');
    if (!fs.existsSync(seg)) throw new Error(`narration missing: ${seg} (run tools/narration/synthesize-neural.cjs first)`);
    this.segments = Object.fromEntries(JSON.parse(fs.readFileSync(seg, 'utf8')).map((x) => [x.id, x]));
  }
  now() { return this.n / FPS; }
  /** Pause the page clock (installed before load) — from here on time only moves when a frame is captured. */
  async start() { await this.page.clock.pauseAt((await this.page.evaluate(() => Date.now())) + 1000); }
  /** Advance the page clock by exactly one frame, then take a device-pixel screenshot of the whole viewport. */
  async frame() {
    await this.page.clock.runFor(1000 / FPS);
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, optimizeForSpeed: true, clip: { x: 0, y: 0, ...VIEWPORT, scale: DPR } });
    const file = `frames/${String(this.n + 1).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(this.dir, file), Buffer.from(shot.data, 'base64'));
    this.frames.push({ file, t: Number((this.n / FPS).toFixed(4)) });
    this.n += 1;
  }
  async hold(seconds) { const end = this.n + Math.round(seconds * FPS); while (this.n < end) await this.frame(); }
  /** A CSS/Playwright selector string or a Locator → the first match. */
  loc(target) { return typeof target === 'string' ? this.page.locator(target).first() : target.first(); }
  /** Keeps capturing (the UI keeps living) until `target` is visible. Playwright waits would not advance a paused clock. */
  async until(target, timeoutS = 15) {
    if (target && typeof target === 'object' && 'w' in target && !target.first) return;
    const end = this.n + timeoutS * FPS;
    while (!(await this.loc(target).isVisible().catch(() => false))) { if (this.n > end) throw new Error(`not visible within ${timeoutS}s: ${target}`); await this.frame(); }
  }
  /** Keeps capturing until `fn()` is truthy (a URL change, an element going away, …). */
  async untilFn(fn, what, timeoutS = 20) {
    const end = this.n + timeoutS * FPS;
    while (!(await fn().catch(() => false))) { if (this.n > end) throw new Error(`timed out (${timeoutS}s): ${what}`); await this.frame(); }
  }
  async gone(target, timeoutS) { await this.untilFn(async () => !(await this.loc(target).isVisible()), `gone: ${target}`, timeoutS); }
  async url(re, timeoutS) { await this.untilFn(async () => re.test(this.page.url()), `url ${re}`, timeoutS); }
  async box(target) {
    // An explicit region {x, y, w, h} in CSS px (e.g. "the top-left of the list") is framed as given.
    if (target && typeof target === 'object' && 'w' in target && !target.first) return { ...target, label: target.label || 'region' };
    const l = this.loc(target);
    if (!(await l.isVisible().catch(() => false))) return null;
    return l.evaluate((el) => {
      // Clip to the visible viewport: a camera can only frame what is actually on screen.
      const raw = el.getBoundingClientRect();
      const x0 = Math.max(0, raw.left), y0 = Math.max(0, raw.top), x1 = Math.min(innerWidth, raw.right), y1 = Math.min(innerHeight, raw.bottom);
      if (x1 <= x0 || y1 <= y0) return null;
      // Labels only — never an input's value.
      const label = el.matches('input,textarea,select,[contenteditable]') ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName.toLowerCase())
        : (el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\s+/g, ' ');
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: label.slice(0, 60) };
    }, undefined, { timeout: 3000 }).catch(() => null);
  }
  event(type, extra) { this.events.push({ t: Number(this.now().toFixed(3)), type, ...extra }); }
  async mark(id, target) {
    await this.until(target);
    let b = await this.box(target);
    if (!b) { await this.scrollTo(target); b = await this.box(target); }   // below the fold: bring it on screen first
    if (!b) throw new Error(`not on screen: ${target}`);
    this.event('mark', { id, selector: target && target.w ? 'region' : String(target), bbox: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.w.toFixed(1), h: +b.h.toFixed(1) }, label: b.label });
  }
  /** Camera cue: frame these targets (union, with margins) starting now. Recorded beside the action it explains. */
  async focus(id, targets, { chapter = null, duration = 0.8, offset = 0 } = {}) {
    const marks = [];
    for (const [i, t] of [].concat(targets).entries()) { const m = `${id}.${i}`; await this.mark(m, t); marks.push(m); }
    this.event('camera', { id, marks, chapter, duration, offset });
  }
  /** Camera cue: back to the whole screen (context before a page change or a new region). */
  wide(id, { chapter = null, duration = 0.9, offset = 0 } = {}) { this.event('camera', { id, rect: 'full', chapter, duration, offset }); }
  /** Brings a target into view by scrolling its scroll container over a few frames (never a jump cut). */
  async scrollTo(target, { seconds = 0.5, margin = 32 } = {}) {
    if (target && typeof target === 'object' && 'w' in target && !target.first) return;
    const plan = await this.loc(target).evaluate((el, m) => {
      let sc = el.parentElement;
      while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
      const box = el.getBoundingClientRect();
      const view = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      const top = Math.max(view.top, 0) + m, bottom = Math.min(view.bottom, innerHeight) - m;
      let d = 0;
      if (box.top < top) d = box.top - top; else if (box.bottom > bottom) d = Math.min(box.bottom - bottom, box.top - top);
      if (Math.abs(d) < 2) return null;
      const s = sc || document.scrollingElement;
      window.__docScroller = s;
      return { from: s.scrollTop, d };
    }, margin, { timeout: 3000 });
    if (!plan) return;
    const n = Math.max(6, Math.round(seconds * FPS));
    for (let i = 1; i <= n; i++) {
      const k = i / n; const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      await this.page.evaluate((v) => window.__docScroller.scrollTo({ top: v, behavior: 'instant' }), plan.from + plan.d * e);
      await this.frame();
    }
  }
  /** Scrolls a horizontal container sideways by dx CSS px over `seconds`. */
  async scrollX(selector, dx, seconds = 0.8) {
    const from = await this.loc(selector).evaluate((el) => el.scrollLeft);
    const n = Math.max(6, Math.round(seconds * FPS));
    for (let i = 1; i <= n; i++) {
      const k = i / n; const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      await this.loc(selector).evaluate((el, v) => el.scrollTo({ left: v, behavior: 'instant' }), from + dx * e);
      await this.frame();
    }
  }
  /** Fictional demo text only, typed key by key on the frame clock. Never used for passwords or tokens. */
  async type(target, text, { clear = false, end = false } = {}) {
    await this.click(target, { settle: 0.1 });
    if (end) await this.page.keyboard.press('End');
    if (clear) { await this.page.keyboard.press('Control+A'); await this.page.keyboard.press('Backspace'); await this.frame(); }
    for (const ch of text) { await this.page.keyboard.type(ch); await this.frame(); await this.frame(); }
    await this.hold(0.25);
  }
  async select(target, value) { await this.click(target, { settle: 0.1 }); await this.loc(target).selectOption(value, { timeout: 3000 }); await this.hold(0.45); }
  async fill(target, value) { await this.click(target, { settle: 0.1 }); await this.loc(target).fill(value, { timeout: 3000 }); await this.hold(0.35); }
  async upload(target, file) {
    const chooser = this.page.waitForEvent('filechooser', { timeout: 5000 });
    await this.click(target);
    await (await chooser).setFiles(file);
    await this.hold(0.4);
  }
  async press(key) { await this.page.keyboard.press(key); await this.hold(0.2); }
  /** Eased, intentional pointer travel (350–750 ms by distance), one mouse event per captured frame, then a short settle. */
  async moveTo(selector, { dx = 0, dy = 0, center = true, settle = 0.3, scroll = true } = {}) {
    await this.until(selector);
    if (scroll) await this.scrollTo(selector).catch(() => {});
    const b = await this.box(selector);
    if (!b) throw new Error(`not on screen: ${selector}`);
    const x = Math.round(b.x + (center ? b.w / 2 : Math.min(b.w / 2, 60)) + dx);
    const y = Math.round(b.y + b.h / 2 + dy);
    const from = { ...this.mouse };
    const dist = Math.hypot(x - from.x, y - from.y);
    const frames = Math.max(8, Math.round((Math.max(350, Math.min(750, 250 + dist * 0.6)) / 1000) * FPS));
    this.event('move-start', { x: from.x, y: from.y });
    for (let i = 1; i <= frames; i++) {
      const k = i / frames; const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await this.frame();
    }
    this.mouse = { x, y };
    this.event('move', { x, y, selector: String(selector), bbox: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.w.toFixed(1), h: +b.h.toFixed(1) }, label: b.label });
    await this.hold(settle);
  }
  async click(selector, opts) {
    await this.moveTo(selector, opts);
    this.event('click', { x: this.mouse.x, y: this.mouse.y, selector: String(selector) });
    await this.page.mouse.down(); await this.frame(); await this.frame(); await this.page.mouse.up();
    await this.hold(0.35);
  }
  async say(id) {
    const seg = this.segments[id];
    if (!seg) throw new Error(`narration segment missing: ${this.slug}/${id}`);
    await this.waitSpeech();
    const t = this.now();
    this.cues.push({ id, start: Number(t.toFixed(3)), seconds: seg.seconds, text: seg.text, file: path.join(NARRATION_ROOT, this.narration, seg.file) });
    this.speechEnd = t + seg.seconds + (seg.pauseAfter ?? SPEECH_GAP_S); // longer breaths at scene changes
  }
  async waitSpeech() { while (this.now() < this.speechEnd) await this.frame(); }
  async finish(tail = 1.0) {
    await this.waitSpeech(); await this.hold(tail);
    fs.writeFileSync(path.join(this.dir, 'frames.json'), JSON.stringify(this.frames));
    fs.writeFileSync(path.join(this.dir, 'cues.json'), JSON.stringify(this.cues, null, 2));
    fs.writeFileSync(path.join(this.dir, 'captions.json'), JSON.stringify(this.cues.map((c) => ({ start: c.start, end: Number((c.start + c.seconds).toFixed(3)), text: c.text })), null, 2));
    fs.writeFileSync(path.join(this.dir, 'events.json'), JSON.stringify({ viewport: VIEWPORT, dpr: DPR, fps: FPS, frameSize: { width: VIEWPORT.width * DPR, height: VIEWPORT.height * DPR }, coordinates: 'CSS px of the viewport; frame px = CSS px × dpr', events: this.events }, null, 2));
    return { frames: this.n, seconds: this.now() };
  }
}

// ── Shot scripts: real UI actions paced by the narration. Selectors are the app's own; nothing is mutated. ──────────
const SCRIPTS = {
  // Full Dashboard tutorial. Each line's action happens while it is spoken; the camera plan (tools/cinematic/shots/)
  // frames the marked regions. No data is changed: hovering, and paging the week view, are read-only.
  async 'dashboard-cinematic'(r) {
    await r.click('aside.sidebar a.nav-item[aria-label="Dashboard"]', { center: false, settle: 0 });
    r.event('cut-in', {});
    await r.until('.dash-counts dd');
    await r.say('intro');                                   // wide: the real count-up and growing bars
    await r.waitSpeech();
    await r.say('strip');
    await r.mark('strip', '.dash-strip');
    await r.hold(0.6);
    await r.moveTo('.dash-strip-item:nth-child(1)');
    await r.hold(0.8);
    await r.moveTo('.dash-strip-item:nth-child(2)');
    await r.hold(0.6);
    await r.moveTo('.dash-strip-item:nth-child(3)', { dx: -120 });
    await r.waitSpeech();
    await r.say('counts');
    await r.mark('counts', '.dash-counts');
    await r.moveTo('.dash-counts > div:nth-child(1)');
    await r.hold(0.5);
    await r.moveTo('.dash-counts > div:nth-child(3)');
    await r.waitSpeech();
    await r.say('hours');
    await r.mark('hours-card', '.dash-hours');
    await r.moveTo('.dash-hours .dash-big');
    await r.waitSpeech();
    await r.say('hover');
    await r.moveTo('.dash-hours .dash-bar-col:nth-child(6) .dash-bar-track');
    await r.mark('tooltip', '.dash-hours .dash-tooltip');
    await r.waitSpeech();
    await r.say('venues');
    await r.mark('venues-card', '.dash-venues');
    await r.moveTo('.dash-venues .dash-hbars li:nth-child(1) .dash-hbar-track');
    await r.hold(0.8);
    await r.moveTo('.dash-venues .dash-hbars li:nth-child(3) .dash-hbar-track');
    await r.waitSpeech();
    await r.say('readiness');
    await r.mark('readiness-head', '.dash-readiness .dash-card-head');
    await r.mark('readiness-stages', '.dash-readiness .dash-stages');
    await r.hold(1.2);                                       // the camera returns to context first
    await r.moveTo('.dash-readiness .dash-stage:nth-child(1)');
    await r.waitSpeech();
    await r.say('checklist');
    await r.mark('checklist', '.dash-readiness .dash-checklist');
    await r.moveTo('.dash-checklist ul li:nth-child(1)', { center: false });
    await r.hold(0.6);
    await r.moveTo('.dash-checklist ul li:nth-child(4)', { center: false });
    await r.waitSpeech();
    await r.say('week');
    await r.mark('week-nav', '.dash-week-card .dash-week-nav');
    await r.mark('week-grid', '.dash-week-card .dash-week-grid');
    await r.moveTo('.dash-week-card .dash-week-grid .dash-week-day:nth-child(2)');
    await r.hold(1.6);
    await r.click('.dash-week-card button[aria-label="Next week"]');
    await r.waitSpeech();
    await r.say('close');
    await r.moveTo('.dash-hours .dash-card-link');
  },

  async 'dashboard-cinematic-sample'(r) {
    await r.click('aside.sidebar a.nav-item[aria-label="Dashboard"]', { center: false, settle: 0 });
    r.event('cut-in', {});                      // the edit starts here: the Dashboard mounts and its reveal begins
    await r.until('.dash-counts dd');
    await r.say('wide');                       // wide: the real numbers count up and the bars grow
    await r.waitSpeech();
    await r.hold(0.4);
    await r.say('hours');
    await r.mark('hours-card', '.dash-hours');
    await r.moveTo('.dash-hours .dash-big');
    await r.waitSpeech();
    await r.say('hover');
    await r.moveTo('.dash-hours .dash-bar-col:nth-child(6) .dash-bar-track');
    await r.mark('tooltip', '.dash-hours .dash-tooltip');
    await r.waitSpeech();
    await r.say('return');
    await r.moveTo('.dash-overview', { dx: 260 });   // off the chart: the tooltip closes before the camera widens
  },
};

// ── Task tutorials (same actions and fictional data as record-tutorials.cjs, re-shot for the editorial camera). ─────
// `focus()` / `wide()` are camera cues: they record WHICH real UI region the camera frames and WHEN, beside the action
// they explain; tools/cinematic/build-composition.cjs turns them into eased camera keyframes.
const nav = (label) => `aside.sidebar a.nav-item[aria-label="${label}"]`;
const fld = (label, tag = 'input', scope = drawer) => `${scope} .field:has(> label:text-is("${label}")) ${tag}`;
const ymd = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toLocaleDateString('sv-SE'); };
const SIDEBAR_AND_TOP = { x: 0, y: 0, w: 1040, h: 500 };   // nav + the top of the open page, one calm framing
const LIST_TOP = { x: 248, y: 0, w: 980, h: 430 };          // page tabs, toolbar and the first rows of a list

Object.assign(SCRIPTS, {
  async 'overview-tour'(r) {
    await r.until('.dash-counts dd');
    await r.say('intro'); await r.hold(1.2);
    await r.say('dashboard');
    await r.focus('dash', ['.dash-strip', '.dash-counts'], { chapter: 'Dashboard' });
    await r.moveTo('.dash-counts > div:nth-child(1)'); await r.hold(0.8);
    await r.focus('dash-cards', ['.dash-hours', '.dash-venues']);
    await r.moveTo('.dash-hours .dash-card-link');
    await r.say('sidebar');
    await r.focus('sidebar', [{ x: 0, y: 40, w: 560, h: 560 }], { chapter: 'Sidebar' });
    await r.moveTo(nav('Dashboard')); await r.hold(1.0);
    await r.moveTo('.sidebar-group:has-text("Operations") .sidebar-group-label'); await r.hold(1.4);
    await r.moveTo('.sidebar-group:has-text("Workspace") .sidebar-group-label');
    await r.say('users');
    await r.focus('pages', [SIDEBAR_AND_TOP], { chapter: 'Main pages' });
    await r.click(nav('Users')); await r.hold(0.8);
    for (const [id, label] of [['shifts', 'Shifts'], ['offers', 'Offers'], ['venue-offers', 'Venue Offers']]) {
      await r.say(id);
      await r.click(nav(label)); await r.hold(0.8);
    }
    await r.say('calendar');
    await r.wide('calendar', { chapter: 'Calendar' });
    await r.click(nav('Calendar')); await r.hold(1.2);
    await r.moveTo('.calendar-detail').catch(() => {});
    await r.say('search');
    await r.press('/'); await r.hold(0.6);
    await r.focus('search', ['.side-panel-input'], { chapter: 'Search' });
    for (const ch of 'Ri') { await r.page.keyboard.type(ch); await r.hold(0.14); }
    await r.hold(2.2);
    await r.press('Escape');
    await r.say('help');
    await r.wide('help', { chapter: 'Help Center' });
    await r.click(nav('Help Center')); await r.hold(0.8);
  },

  async 'sidebar-shortcuts'(r) {
    await r.say('intro'); await r.hold(1.2);
    await r.say('plus');
    await r.focus('ops', ['.sidebar-group:has-text("Operations")', 'button[aria-label="Add menu item"]'], { chapter: 'Add menu item' });
    await r.click('button[aria-label="Add menu item"]');
    await r.until('.add-menu');
    await r.say('kinds');
    await r.focus('menu', ['.add-menu']);
    for (const k of ['Object', 'View', 'Record', 'Folder', 'Link']) { await r.moveTo(`.add-menu-row:has-text("${k}")`); await r.hold(0.45); }
    await r.say('choose');
    await r.click('.add-menu-row:has-text("View")'); await r.hold(0.6);
    await r.focus('views', ['.add-menu']);
    await r.click('.add-menu-row:has-text("Offers · Pending")'); await r.hold(0.6);
    await r.say('confirm');
    await r.focus('confirm', ['.add-menu']);
    await r.type('#add-menu-name', ' (mine)', { end: true });
    await r.click('.add-menu-icons button[aria-label="star"]'); await r.hold(0.4);
    await r.click('.add-menu-actions button:has-text("Add")');
    await r.until('.shortcut-list');
    await r.say('result');
    await r.focus('result', ['.sidebar-group:has-text("Operations")'], { chapter: 'Your shortcut' });
    await r.moveTo('.shortcut-list .shortcut-item'); await r.hold(1.8);
    await r.say('manage');
    await r.click('.shortcut-list button.shortcut-more'); await r.hold(1.6);
    await r.press('Escape');
  },

  async 'create-workspace'(r, { browser }) {
    const logo = { name: 'northwind-logo.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'logo') };
    const photo = { name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'avatar', 'jordan') };
    await r.say('intro'); await r.hold(1.0);
    await r.say('logo');
    await r.focus('logo', ['button:has-text("Upload logo")', '#ws-name'], { chapter: 'Workspace' });
    await r.upload('button:has-text("Upload logo")', logo);
    await r.say('name');
    await r.type('#ws-name', 'Northwind Staffing');
    await r.until(r.page.getByText('is available'));
    await r.say('address');
    await r.focus('address', ['#ws-subdomain', r.page.getByText('is available')]);
    await r.type('#ws-subdomain', 'northwind', { clear: true });
    await r.until(r.page.getByText('✓ northwind is available')); await r.hold(1.0);
    await r.waitSpeech();
    await r.focus('create', ['#ws-subdomain', 'button:has-text("Create workspace")']);
    await r.click('button:has-text("Create workspace")');
    await r.url(/\/onboarding\/profile/);
    await r.say('profile');
    await r.focus('profile', ['button:has-text("Upload photo")', '#p-title'], { chapter: 'Your profile' });
    await r.upload('button:has-text("Upload photo")', photo);
    await r.type('#p-first', 'Jordan');
    await r.type('#p-last', 'Hale');
    await r.type('#p-title', 'Operations manager');
    await r.waitSpeech();
    await r.focus('complete', ['#p-title', 'button:has-text("Complete setup")']);
    await r.click('button:has-text("Complete setup")');
    await r.url(/\/onboarding\/preparing/);
    await r.wide('preparing', { chapter: 'Preparing' });
    await r.say('preparing');
    await r.until('.welcome-overlay', 30);
    await r.say('ready');
    await r.url(/:\d+\/$/, 20);
    await r.hold(1.0);
  },

  async 'invite-manager'(r) {
    await r.say('intro'); await r.hold(1.2);
    await r.say('open');
    await r.focus('tabs', [LIST_TOP]);
    await r.click('button.tab-link:has-text("Managers")'); await r.hold(0.8);
    await r.say('new');
    await r.wide('new');
    await r.click('button:has-text("New manager")');
    await r.until(fld('First name *'));
    await r.say('name');
    await r.focus('name', [fld('First name *'), fld('Last name *')], { chapter: 'New manager' });
    await r.type(fld('First name *'), 'Jesse');
    await r.type(fld('Last name *'), 'Clarke');
    await r.say('type');
    await r.focus('type', [fld('Manager type', 'select'), fld('Job title')]);
    await r.moveTo(fld('Manager type', 'select')); await r.hold(0.8);
    await r.type(fld('Job title'), 'Area manager');
    await r.say('contact');
    await r.scrollTo(fld('Email *'));
    await r.focus('contact', [fld('Email *'), `${drawer} input.PhoneInputInput`]);
    await r.type(fld('Email *'), 'jesse.clarke@example.test');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900412');
    await r.say('create');
    await r.wide('create');
    await r.click(`${drawer} button:has-text("Create manager")`);
    await r.until(`${drawer} .detail-tabs`);
    await r.say('status');
    await r.focus('status', [`${drawer} .drawer-header`], { chapter: 'Invitation sent' });
    await r.moveTo(`${drawer} .drawer-header .badge`); await r.hold(1.4);
  },

  async 'add-staff'(r) {
    await r.say('intro'); await r.hold(1.2);
    await r.say('open');
    await r.focus('new', ['button:has-text("New staff")', 'button.tab-link:has-text("Staff")']);
    await r.click('button:has-text("New staff")');
    await r.until(fld('First name *'));
    await r.wide('drawer');
    await r.say('step1');
    await r.focus('names', [fld('First name *'), fld('Last name *')], { chapter: 'Step 1 · Details' });
    await r.type(fld('First name *'), 'Rowan');
    await r.type(fld('Last name *'), 'Price');
    await r.focus('employment', [fld('Job role', 'select'), fld('Default rate (£/hr)')]);
    await r.select(fld('Job role', 'select'), { label: 'Bartender' });
    await r.select(fld('Employment type', 'select'), 'Part-time');
    await r.type(fld('Default rate (£/hr)'), '14.50');
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Next")`);
    await r.say('step2');
    await r.focus('contact', [fld('Email *'), fld('City')], { chapter: 'Step 2 · Contact' });
    await r.type(fld('Email *'), 'rowan.price@example.test');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900345');
    await r.type(fld('City'), 'Bristol');
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Next")`);
    await r.say('step3');
    await r.focus('emergency', [fld('Full name *'), `${drawer} input.PhoneInputInput`], { chapter: 'Step 3 · Emergency contact' });
    await r.type(fld('Full name *'), 'Charlie Price');
    await r.type(fld('Relationship *'), 'Sister');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900388');
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Next")`);
    await r.say('step4');
    await r.focus('availability', [`${drawer} label.weekday-picker-option:has-text("Mon")`, fld('Maximum hours per week')], { chapter: 'Step 4 · Availability' });
    for (const d of ['Mon', 'Wed', 'Fri', 'Sat']) await r.click(`${drawer} label.weekday-picker-option:has-text("${d}")`, { settle: 0.1 });
    await r.select(fld('Preferred shift times', 'select'), 'Evening');
    await r.type(fld('Maximum hours per week'), '30');
    await r.say('create');
    await r.wide('create');
    await r.click(`${drawer} button:has-text("Create")`);
    await r.until(`${drawer} .detail-tabs`);
    await r.say('result');
    await r.focus('result', [`${drawer} .drawer-header`], { chapter: 'Invitation sent' });
    await r.moveTo(`${drawer} .drawer-header .badge`); await r.hold(1.4);
  },

  async 'assign-venue-manager-staff'(r) {
    await r.say('intro'); await r.hold(1.6);
    await r.say('open');
    await r.click(nav('Users'));
    await r.until('button.tab-link:has-text("Venue managers")');
    await r.focus('tabs', [LIST_TOP]);
    await r.click('button.tab-link:has-text("Venue managers")');
    await r.until('tbody tr:has-text("Riley Chen")');
    await r.say('view');
    await r.wide('view');
    await r.click('tr:has-text("Riley Chen") button[title="View"]');
    await r.until(drawer);
    await r.say('tab');
    await r.focus('tab', [`${drawer} .detail-tabs`, `${drawer} .drawer-header`], { chapter: 'Assigned staff' });
    await r.click(`${drawer} .detail-tab-more-trigger`); await r.hold(0.5);
    await r.click(r.page.getByRole('menuitem', { name: 'Assigned staff' }));
    await r.until(`${drawer} [aria-label="Assigned staff"] li`);
    await r.say('list');
    await r.focus('list', [`${drawer} [aria-label="Assigned staff"] li:nth-child(1)`, `${drawer} [aria-label="Assigned staff"] li:nth-child(4)`]);
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:nth-child(2)`); await r.hold(1.2);
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:nth-child(4)`);
    await r.say('add');
    await r.wide('add');
    await r.click(r.page.locator(`${drawer} button`, { hasText: 'Add Staff' }).last());
    await r.until(r.page.getByRole('heading', { name: 'Select Staff' }));
    await r.hold(0.8);
    await r.focus('picker', [r.page.getByRole('heading', { name: 'Select Staff' }), 'tr:has-text("Grace Kim") .badge'], { chapter: 'Select Staff' });
    await r.moveTo('tr:has-text("Grace Kim") .badge'); await r.hold(1.0);
    await r.say('pick');
    await r.focus('pick', [r.page.getByLabel('Select Isla Moore', { exact: true }), r.page.getByLabel('Select Kai Turner', { exact: true }), 'tr:has-text("Kai Turner") td:nth-child(3)']);
    for (const n of ['Isla Moore', 'Kai Turner']) await r.click(r.page.getByLabel(`Select ${n}`, { exact: true }));
    await r.hold(0.5);
    await r.wide('confirm');
    await r.click(r.page.getByRole('button', { name: 'Confirm', exact: true }));
    await r.gone(r.page.getByRole('heading', { name: 'Select Staff' }));
    await r.say('done');
    await r.focus('done', [`${drawer} [aria-label="Assigned staff"] li:last-child`, `${drawer} [aria-label="Assigned staff"] li:nth-last-child(3)`], { chapter: 'Team updated' });
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:last-child`); await r.hold(1.4);
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:last-child button`);
  },

  async 'staff-reviews'(r) {
    await r.say('intro'); await r.hold(1.6);
    await r.say('open');
    await r.click(nav('Users')); await r.until('tr:has-text("Alex Morgan")');
    await r.click('tr:has-text("Alex Morgan") button[title="View"]');
    await r.until(drawer);
    await r.say('tab');
    await r.focus('tab', [`${drawer} .detail-tabs`, `${drawer} .drawer-header`], { chapter: 'Staff reviews' });
    await r.click(`${drawer} .detail-tab-more-trigger`); await r.hold(0.5);
    await r.click(r.page.getByRole('menuitem', { name: 'Staff reviews' }));
    await r.until(r.page.getByText('Review history').first());
    await r.say('overall');
    await r.focus('overall', [`${drawer} [aria-label="Overall rating"]`], { chapter: 'Overall rating' });
    await r.moveTo(`${drawer} [aria-label="Overall rating"]`);
    await r.say('categories');
    await r.scrollTo(`${drawer} [aria-label="Average scores"]`);
    await r.focus('categories', [`${drawer} [aria-label="Average scores"]`], { chapter: 'By category' });
    await r.moveTo(`${drawer} [aria-label="Average scores"]`);
    await r.say('filter');
    await r.scrollTo(r.page.locator(drawer).getByText('All venue managers').first());
    await r.focus('filter', [r.page.locator(drawer).getByText('All venue managers').first(), `${drawer} .sr-range-row`], { chapter: 'Filters' });
    await r.moveTo(r.page.locator(drawer).getByText('All venue managers').first()); await r.hold(1.2);
    await r.click(r.page.locator(`${drawer} .sr-range-row button`).first()); await r.hold(0.6);
    await r.click(r.page.getByRole('option', { name: 'This month' }).or(r.page.locator('.list-view-option', { hasText: 'This month' })).first());
    await r.hold(0.8);
    await r.say('history');
    await r.scrollTo(r.page.locator(drawer).getByText('Review history'));
    await r.focus('history', [r.page.locator(drawer).getByText('Review history'), r.page.locator(`${drawer} button`, { hasText: 'View review' }).first()], { chapter: 'Review history' });
    await r.moveTo(r.page.locator(drawer).getByText('Review history')); await r.hold(1.2);
    await r.click(r.page.locator(`${drawer} button`, { hasText: 'View review' }).first());
    await r.until(r.page.getByText('Staff performance'));
    await r.say('detail');
    await r.focus('detail', [r.page.locator(drawer).getByText('Staff performance')], { chapter: 'Shift review' });
    await r.moveTo(r.page.locator(drawer).getByText('Staff performance')); await r.hold(2.0);
    await r.scrollTo(r.page.locator(drawer).getByText('Written feedback'));
    await r.focus('feedback', [r.page.locator(drawer).getByText('Written feedback')]);
    await r.moveTo(r.page.locator(drawer).getByText('Written feedback'));
  },

  async 'create-venue'(r) {
    await r.say('intro'); await r.hold(1.2);
    await r.say('open');
    await r.focus('new', ['button:has-text("New venue")', LIST_TOP]);
    await r.click('button:has-text("New venue")');
    await r.until(fld('Venue name'));
    await r.say('details');
    await r.focus('details', [fld('Venue name'), fld('Type', 'select')], { chapter: 'Venue details' });
    await r.type(fld('Venue name'), 'Lakeside Pavilion');
    await r.type(fld('Client name'), 'Lakeside Leisure Ltd');
    await r.select(fld('Type', 'select'), 'event');
    await r.say('address');
    await r.scrollTo(fld('Postcode'));
    await r.focus('address', [fld('Address'), fld('Postcode')], { chapter: 'Address' });
    await r.type(fld('Address'), '5 Example Parade');
    await r.type(fld('City'), 'Leeds');
    await r.type(fld('Postcode'), 'LS1 9XX');
    await r.say('geofence');
    await r.scrollTo('#venue-radius');
    await r.focus('geofence', ['#venue-lat', '#venue-radius', `${drawer} input[role=switch]`], { chapter: 'Geofence' });
    await r.type('#venue-lat', '53.7965');
    await r.type('#venue-lng', '-1.5478');
    await r.type('#venue-radius', '150', { clear: true });
    await r.click(`${drawer} input[role=switch]`);
    await r.say('break');
    await r.scrollTo(fld('Default break minutes'));
    await r.focus('break', [fld('Default break minutes')], { chapter: 'Breaks' });
    await r.type(fld('Default break minutes'), '30');
    await r.say('create');
    await r.wide('create');
    await r.click(`${drawer} button:has-text("Create venue")`);
    await r.until(r.page.getByText('+ Add another role rate'));
    await r.say('rates');
    await r.scrollTo(fld('Hourly rate (£)'));
    await r.focus('rates', [fld('Role', 'select'), fld('Hourly rate (£)'), `${drawer} button:has-text("+ Add another role rate")`], { chapter: 'Pay rates' });
    await r.select(fld('Role', 'select'), { label: 'Event staff' });
    await r.type(fld('Hourly rate (£)'), '14.75');
    await r.click(`${drawer} button:has-text("+ Add another role rate")`);
    await r.until(r.page.locator(drawer).getByText('£14.75/h')); await r.hold(0.6);
    await r.wide('save');
    await r.click(`${drawer} button:has-text("Save changes")`);
    await r.say('done');
    await r.until('tr:has-text("Lakeside Pavilion")');
    await r.focus('done', ['tr:has-text("Lakeside Pavilion") td:nth-child(2)', 'tr:has-text("Lakeside Pavilion") td:nth-child(5)'], { chapter: 'Venue created' });
    await r.moveTo('tr:has-text("Lakeside Pavilion")', { center: false }); await r.hold(1.4);
  },

  async 'create-shift-send-offers'(r) {
    await r.say('intro'); await r.hold(1.2);
    await r.say('open');
    await r.focus('new', ['button:has-text("New shift")', LIST_TOP]);
    await r.click('button:has-text("New shift")');
    await r.until(`${drawer} .field:has(> label:text-is("Venue")) button`);
    await r.say('venue');
    await r.focus('venue', [`${drawer} .field:has(> label:text-is("Venue"))`, `${drawer} .field:has(> label:text-is("Role"))`], { chapter: 'Venue and role' });
    // The Venue/Role pickers' menu currently opens off-screen inside this drawer (SearchableSelect sets viewport
    // coordinates on a `position:absolute` .dropdown-menu — reported as a UI defect). Its own keyboard support is used
    // instead: the click opens it, its search box is focused WITHOUT scrolling (moving focus there normally scrolls the
    // drawer sideways towards the off-screen menu and blanks the form — the same defect), typing filters it and Enter
    // picks the first match.
    for (const [label, text] of [['Venue', 'Riverside'], ['Role', 'Waiting']]) {
      await r.click(`${drawer} .field:has(> label:text-is("${label}")) button`);
      await r.hold(0.2);
      await r.page.evaluate(() => document.querySelector('.dropdown-menu .side-panel-input input')?.focus({ preventScroll: true }));
      for (const ch of text) { await r.page.keyboard.type(ch); await r.frame(); await r.frame(); }
      await r.press('Enter');
      await r.hold(0.4);
    }
    await r.say('time');
    await r.scrollTo(fld('Break (minutes)'));
    await r.focus('time', [fld('Date'), fld('End time'), fld('Break (minutes)')], { chapter: 'Date and time' });
    await r.fill(fld('Date'), ymd(1));
    await r.fill(fld('Start time'), '12:00');
    await r.fill(fld('End time'), '18:00');
    await r.type(fld('Break (minutes)'), '30', { clear: true });
    await r.say('staff');
    await r.wide('staff');
    await r.click(r.page.getByRole('button', { name: 'Select staff' }));
    await r.until(r.page.getByRole('heading', { name: 'Select Staff' }));
    await r.focus('pick', [r.page.getByLabel('Select Alex Morgan', { exact: true }), r.page.getByLabel('Select Sam Reed', { exact: true }), 'tr:has-text("Sam Reed") td:nth-child(4)'], { chapter: 'Select Staff' });
    for (const n of ['Alex Morgan', 'Priya Shah', 'Sam Reed']) await r.click(r.page.getByLabel(`Select ${n}`, { exact: true }));
    await r.hold(0.4);
    await r.wide('confirm');
    await r.click(r.page.getByRole('button', { name: 'Confirm', exact: true }));
    await r.gone(r.page.getByRole('heading', { name: 'Select Staff' }));
    await r.say('send');
    await r.click(`${drawer} button:has-text("Send Offer")`);
    await r.until(r.page.getByText(/Shift created ✓/));
    await r.say('result');
    await r.focus('result', [r.page.getByText(/Shift created ✓/), `${drawer} p:has-text("Sam Reed")`], { chapter: 'Offers sent' });
    await r.moveTo(`${drawer} p:has-text("Sam Reed")`).catch(() => {});
    await r.hold(1.4);
  },

  async 'venue-request-approval'(r) {
    await r.say('intro'); await r.hold(1.6);
    await r.say('open');
    await r.click(nav('Venue Offers')); await r.until('tr:has-text("Pending approval") .badge');
    await r.focus('pending', ['tr:has-text("Pending approval") td:nth-child(1)', 'tr:has-text("Pending approval") .badge'], { chapter: 'Pending approval' });
    await r.moveTo('tr:has-text("Pending approval") .badge');
    await r.say('review');
    await r.wide('review');
    await r.click('tr:has-text("Pending approval")');
    await r.until(r.page.getByText('Selected staff'));
    await r.hold(1.0);
    await r.focus('selected', [r.page.locator(drawer).getByText('Selected staff'), r.page.locator(drawer).getByText(/selected \/ \d+ required/)], { chapter: 'The request' });
    await r.moveTo(r.page.locator(drawer).getByText('Selected staff'));
    await r.say('gap');
    await r.moveTo(r.page.locator(drawer).getByText(/selected \/ \d+ required/));
    await r.waitSpeech();
    await r.wide('select');
    await r.click(`${drawer} button:has-text("Select 2 Staff")`);
    await r.until('.staff-selection-page table');
    await r.say('pick');
    await r.focus('pick', ['.staff-selection-page tr:has-text("Leah Fischer") td:nth-child(2)', '.staff-selection-page tr:has-text("Isla Moore") td:nth-child(2)'], { chapter: 'Select Staff' });
    await r.click('.staff-selection-page tr:has-text("Leah Fischer")', { center: false });
    await r.click('.staff-selection-page tr:has-text("Isla Moore")', { center: false });
    await r.hold(0.5);
    await r.wide('confirm');
    await r.click('.staff-selection-page button:has-text("Confirm")');
    await r.until(r.page.getByText('Staff Complete ✓'));
    await r.say('approve');
    await r.focus('approve', [r.page.getByText('Staff Complete ✓'), `${drawer} button:has-text("Approve")`], { chapter: 'Approve' });
    await r.click(`${drawer} button:has-text("Approve")`);
    await r.until('.pipeline-board'); await r.hold(0.8);
    await r.wide('board');
    await r.say('board');
    await r.focus('offered', ['.pipeline-column.stage-offered', '.pipeline-summary'], { chapter: 'Staffing board' });
    await r.moveTo('.pipeline-column.stage-offered'); await r.hold(1.4);
  },

  async 'confirm-offers'(r) {
    await r.say('intro'); await r.hold(1.6);
    await r.say('view');
    await r.focus('view', ['button[aria-label="Offers view"]', LIST_TOP], { chapter: 'Awaiting Confirmation' });
    await r.click('button[aria-label="Offers view"]');
    await r.click('[role=option]:has-text("Awaiting Confirmation")');
    await r.hold(1.0);
    await r.say('row');
    await r.focus('row', ['tr:has-text("Priya Shah") td:nth-child(2)', 'tr:has-text("Priya Shah") .muted']);
    await r.moveTo('tr:has-text("Priya Shah") .muted');
    await r.say('one');
    await r.focus('tick', ['tr:has-text("Priya Shah") .muted', 'tr:has-text("Priya Shah") button[title="Confirm shift"]']);
    await r.click('tr:has-text("Priya Shah") button[title="Confirm shift"]');
    await r.until(`${drawer} button:has-text("Confirm shift")`);
    await r.wide('drawer');
    await r.hold(1.8);
    await r.click(`${drawer} button:has-text("Confirm shift")`);
    await r.hold(0.8);
    await r.say('all');
    await r.focus('all', ['button:has-text("Confirm All Accepted")', LIST_TOP], { chapter: 'Confirm all' });
    await r.click('button:has-text("Confirm All Accepted")');
    await r.hold(1.0);
    await r.say('confirmed');
    await r.click('button[aria-label="Offers view"]');
    await r.click('[role=option]:has-text("Confirmed")');
    await r.hold(1.0);
    await r.focus('confirmed', ['tr:has-text("Daniel Okafor") td:nth-child(2)', 'tr:has-text("Daniel Okafor") .badge'], { chapter: 'Confirmed' });
    await r.moveTo('tr:has-text("Daniel Okafor") .badge');
  },

  async 'staffing-pipeline'(r) {
    await r.say('intro'); await r.hold(1.6);
    await r.say('open');
    await r.click(nav('Venue Offers')); await r.until('tr:has-text("The Grand Hall")');
    await r.click('tr:has-text("The Grand Hall")', { center: false });
    await r.until('.pipeline-board'); await r.hold(1.0);
    await r.say('summary');
    await r.focus('summary', ['.pipeline-summary'], { chapter: 'Summary' });
    await r.moveTo(r.page.getByText('Required', { exact: true }).first()); await r.hold(1.8);
    await r.moveTo(r.page.getByText('Offered', { exact: true }).first());
    await r.say('lanes');
    await r.wide('lanes', { chapter: 'Twelve lanes' });
    for (let i = 0; i < 8; i++) { await r.scrollX('.pipeline-board', 380, 0.7); await r.hold(0.8); }
    await r.say('card');
    await r.until('.pipeline-column.stage-clocked-in .pipeline-card');
    // The lane tour ends at the far right; scroll back so the Clocked in lane is fully on screen before framing it.
    const back = await r.loc('.pipeline-column.stage-clocked-in').evaluate((el) => el.getBoundingClientRect().left - el.closest('.pipeline-board').getBoundingClientRect().left - 24);
    await r.scrollX('.pipeline-board', back, 0.9);
    await r.focus('card', ['.pipeline-column.stage-clocked-in .pipeline-card'], { chapter: 'Cards' });
    await r.moveTo('.pipeline-column.stage-clocked-in .pipeline-card'); await r.hold(1.4);
    await r.say('back');
    await r.wide('back');
    await r.click('a.pipeline-back'); await r.until('tr:has-text("Harbour Kitchen"):has-text("Fully filled")');
    await r.click('tr:has-text("Harbour Kitchen"):has-text("Fully filled")', { center: false });
    await r.until('.pipeline-board'); await r.hold(1.0);
    await r.say('report');
    await r.focus('report-btn', ['button:has-text("Timesheet report")', '.pipeline-summary']);
    await r.click('button:has-text("Timesheet report")');
    await r.until(`${drawer} .pipeline-report-files`);
    await r.say('drawer');
    await r.focus('files', [`${drawer} section:has-text("Original Timesheet")`, `${drawer} section:has-text("Venue Signed Timesheet")`], { chapter: 'Timesheet report' });
    await r.moveTo(`${drawer} section:has-text("Original Timesheet")`); await r.hold(2.6);
    await r.moveTo(`${drawer} section:has-text("Venue Signed Timesheet")`); await r.hold(2.2);
    await r.moveTo(`${drawer} .pipeline-report-table`);
  },
});

// ── The introduction film's one continuous story (fictional) ───────────────────────────────────────────────────────────
// Riley Chen (venue manager, Riverside House) requests four Waiting staff for a wedding reception on Friday 23 October
// 2026, 12:00–18:00 BST; Priya Shah, Grace Kim, Leah Fischer and Isla Moore work it. These capture-time adjustments keep
// the web footage consistent with the mobile fixture's scenes (tools/mobile-fixture-server.cjs) — data only, no app code.
const STORY_SHIFT = 'vr-river-wedding';
const STORY_STAFF = ['st-priya', 'st-grace', 'st-leah', 'st-isla'];
const Z = (iso) => new Date(iso).toISOString();
const story = {
  /** Before approval: the request names all four (a VM request's size is the number of people picked). */
  request(s) {
    const sh = s.shifts.find((x) => x.id === STORY_SHIFT);
    // A venue manager's request carries no notes in the real product (SchedulingService.submitRequest stores none).
    Object.assign(sh, { startsAt: Z('2026-10-23T11:00:00Z'), endsAt: Z('2026-10-23T17:00:00Z'), breakMinutes: 30, requiredCount: 4, submittedAt: Z('2026-10-20T09:22:00Z'), notes: null });
    s.requestedStaff[STORY_SHIFT] = [...STORY_STAFF];
    // Riley's team before the manager adds Isla on screen (the "Build the team" scene).
    s.vmTeams['mg-riley'] = [['st-alex', 30], ['st-priya', 30], ['st-sam', 21], ['st-maya', 14], ['st-grace', 6], ['st-leah', 4]];
  },
  /** Approved, with Priya's acceptance already booked (approved requests confirm on Accept); the others still deciding. */
  offered(s) {
    story.request(s);
    const sh = s.shifts.find((x) => x.id === STORY_SHIFT);
    sh.status = 'offered';
    delete s.requestedStaff[STORY_SHIFT];
    s.vmTeams['mg-riley'].push(['st-isla', 0]);
    const sentAt = Z('2026-10-20T10:35:00Z');
    STORY_STAFF.forEach((id, i) => s.offers.push({ id: `of-story-${i + 1}`, shiftId: STORY_SHIFT, staffProfileId: id, status: i === 0 ? 'manager_confirmed' : 'pending', offerBatchId: 'b-story', sentAt,
      expiresAt: Z('2026-10-22T10:35:00Z'), respondedAt: i === 0 ? Z('2026-10-20T10:41:00Z') : null, staffAcceptedAt: i === 0 ? Z('2026-10-20T10:41:00Z') : null,
      managerConfirmedAt: i === 0 ? Z('2026-10-20T10:41:00Z') : null, managerRejectedAt: null, rejectionReason: null, declineReason: null, withdrawnReason: null, cancelledAt: null,
      notificationReadAt: i === 2 ? Z('2026-10-20T10:50:00Z') : null }));
    sh.filledCount = 1;
  },
  /** After the shift: everyone confirmed, hours recorded (Isla's clock-out added by Riley's correction), timesheet finalised. */
  done(s) {
    story.offered(s);
    const sh = s.shifts.find((x) => x.id === STORY_SHIFT);
    Object.assign(sh, { status: 'completed', filledCount: 4 });
    s.sessionExpiresAt = Z('2026-10-24T06:00:00Z'); // valid for the pinned Friday-evening page clock
    s.offers.filter((o) => o.shiftId === STORY_SHIFT).forEach((o) => Object.assign(o, { status: 'manager_confirmed', respondedAt: o.respondedAt || Z('2026-10-20T12:10:00Z'), staffAcceptedAt: o.staffAcceptedAt || Z('2026-10-20T12:10:00Z'), managerConfirmedAt: o.managerConfirmedAt || Z('2026-10-20T12:10:00Z') }));
    const times = [['st-priya', '10:52', '17:02'], ['st-grace', '10:55', '17:00'], ['st-leah', '10:58', '17:05'], ['st-isla', '10:56', '17:00']];
    times.forEach(([id, a, b], i) => s.attendance.push({ id: `at-story-${i + 1}`, shiftId: STORY_SHIFT, staffProfileId: id, clockInAt: Z(`2026-10-23T${a}:00Z`), clockOutAt: Z(`2026-10-23T${b}:00Z`), breakMinutes: 30, status: 'completed' }));
  },
};

Object.assign(SCRIPTS, {
  // Chapter 2: the web console and a private workspace.
  async 'intro-web-console'(r) {
    await r.say('c2-web');
    await r.click('aside.sidebar a.nav-item[aria-label="Dashboard"]', { center: false, settle: 0 });
    r.event('cut-in', {});
    await r.until('.dash-counts dd');
    await r.hold(1.6);
    await r.focus('workspace', ['aside.sidebar .sidebar-profile', 'aside.sidebar .sidebar-search-field', nav('Dashboard')], { chapter: 'Private workspace' });
    await r.moveTo('aside.sidebar .sidebar-profile'); await r.hold(1.4);
    await r.waitSpeech();
    await r.wide('back');
    await r.hold(1.0);
  },
  // Chapter 3: staff and venue records, then the manager adds Isla to Riley's team.
  async 'intro-web-team'(r) {
    await r.say('c3-records');
    await r.click(nav('Users')); await r.until('tbody tr');
    r.event('cut-in', {});
    await r.focus('staff', [LIST_TOP]); await r.hold(2.0);
    await r.click(nav('Venues')); await r.until('tr:has-text("Riverside House")');
    await r.focus('venues', ['tr:has-text("Riverside House") td:nth-child(2)', LIST_TOP]); await r.hold(1.2);
    await r.say('c3-assign');
    await r.wide('vm');
    await r.click(nav('Users'));
    await r.until('button.tab-link:has-text("Venue managers")');
    await r.click('button.tab-link:has-text("Venue managers")');
    await r.until('tr:has-text("Riley Chen")');
    await r.click('tr:has-text("Riley Chen") button[title="View"]');
    await r.until(drawer);
    await r.click(`${drawer} .detail-tab-more-trigger`); await r.hold(0.4);
    await r.click(r.page.getByRole('menuitem', { name: 'Assigned staff' }));
    await r.until(`${drawer} [aria-label="Assigned staff"] li`);
    await r.focus('list', [`${drawer} .drawer-header`, `${drawer} [aria-label="Assigned staff"] li:nth-child(6)`], { chapter: 'Assigned team' });
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:nth-child(2)`); await r.hold(0.8);
    await r.wide('add');
    await r.click(r.page.locator(`${drawer} button`, { hasText: 'Add Staff' }).last());
    await r.until(r.page.getByRole('heading', { name: 'Select Staff' }));
    await r.focus('pick', [r.page.getByRole('heading', { name: 'Select Staff' }), r.page.getByLabel('Select Isla Moore', { exact: true }), 'tr:has-text("Isla Moore") td:nth-child(3)']);
    await r.click(r.page.getByLabel('Select Isla Moore', { exact: true }));
    await r.hold(0.4);
    await r.wide('confirm');
    await r.click(r.page.getByRole('button', { name: 'Confirm', exact: true }));
    await r.gone(r.page.getByRole('heading', { name: 'Select Staff' }));
    await r.focus('done', [`${drawer} [aria-label="Assigned staff"] li:last-child`, `${drawer} [aria-label="Assigned staff"] li:nth-last-child(4)`]);
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:last-child`); await r.hold(1.2);
  },
  // Chapter 4: the manager approves Riley's request; the live board opens with four offers.
  async 'intro-web-approve'(r) {
    await r.say('c4-approve');
    await r.click(nav('Venue Offers')); await r.until('tr:has-text("Pending approval")');
    r.event('cut-in', {});
    await r.focus('pending', ['tr:has-text("Pending approval") td:nth-child(1)', 'tr:has-text("Pending approval") .badge']);
    await r.moveTo('tr:has-text("Pending approval") .badge'); await r.hold(0.4);
    await r.wide('open');
    await r.click('tr:has-text("Pending approval")');
    await r.until(r.page.getByText('Selected staff'));
    await r.hold(0.6);
    await r.focus('selected', [r.page.locator(drawer).getByText('Selected staff'), r.page.locator(drawer).getByText(/selected \/ \d+ required/)]);
    await r.moveTo(r.page.locator(drawer).getByText(/selected \/ \d+ required/)); await r.hold(1.0);
    await r.focus('approve', [`${drawer} button:has-text("Approve")`, r.page.getByText('Staff Complete ✓')]);
    await r.click(`${drawer} button:has-text("Approve")`);
    await r.until('.pipeline-board'); await r.hold(0.6);
    await r.wide('board');
    await r.hold(1.6);
  },
  // Chapter 5: the live staffing board for the story shift (Priya confirmed, the others deciding).
  async 'intro-web-board'(r) {
    await r.say('c5-board');
    await r.until('.pipeline-board');
    await r.focus('lanes', ['.pipeline-column.stage-offered', '.pipeline-column.stage-confirmed', '.pipeline-summary']);
    await r.moveTo('.pipeline-column.stage-confirmed .pipeline-card'); await r.hold(1.4);
    await r.wide('wide');
    await r.scrollX('.pipeline-board', 420, 0.9); await r.hold(0.6);
    await r.scrollX('.pipeline-board', -420, 0.9);
    await r.waitSpeech();
  },
  // Chapter 5 branch: a manager-created shift waiting for the manager's confirmation (a different person and venue).
  async 'intro-web-confirm'(r) {
    await r.say('c5-branch');
    await r.click('button[aria-label="Offers view"]');
    await r.click('[role=option]:has-text("Awaiting Confirmation")');
    r.event('cut-in', {});
    await r.hold(0.6);
    await r.focus('row', ['tr:has-text("Daniel Okafor") td:nth-child(2)', 'tr:has-text("Daniel Okafor") button[title="Confirm shift"]']);
    await r.moveTo('tr:has-text("Daniel Okafor") button[title="Confirm shift"]'); await r.hold(1.6);
    await r.waitSpeech();
  },
  // Chapters 8 and 9: the finalised timesheet on the web, then Payroll, staff reviews, calendar and dashboard.
  async 'intro-web-after'(r) {
    await r.say('c8-web');
    await r.click(nav('Venue Offers')); await r.until(`tr:has-text("Riverside House")`);
    r.event('cut-in', {});
    await r.click('tr:has-text("Riverside House"):has-text("23 Oct")', { center: false });
    await r.until('.pipeline-board'); await r.hold(0.6);
    await r.focus('report-btn', ['button:has-text("Timesheet report")', '.pipeline-summary']);
    await r.click('button:has-text("Timesheet report")');
    await r.until(`${drawer} .pipeline-report-files`);
    await r.focus('files', [`${drawer} section:has-text("Original Timesheet")`, `${drawer} section:has-text("Venue Signed Timesheet")`], { chapter: 'Timesheets on the web' });
    await r.moveTo(`${drawer} section:has-text("Venue Signed Timesheet")`); await r.hold(1.2);
    await r.waitSpeech();
    await r.say('c9-payroll');
    await r.press('Escape');
    await r.wide('payroll');
    await r.click(nav('Payroll')); await r.until('tbody tr:has-text("Priya Shah")');
    await r.focus('pay-cols', ['thead th:nth-child(2)', 'thead th:nth-child(6)', 'tbody tr:nth-child(4) td:nth-child(6)'], { chapter: 'Payroll' });
    await r.moveTo('tbody tr:has-text("Priya Shah") td:nth-child(6)'); await r.hold(2.0);
    await r.waitSpeech();
    await r.say('c9-reviews');
    await r.wide('people');
    await r.click(nav('Users')); await r.until('tr:has-text("Priya Shah")');
    await r.click('tr:has-text("Priya Shah") button[title="View"]');
    await r.until(drawer);
    await r.click(`${drawer} .detail-tab-more-trigger`); await r.hold(0.3);
    await r.click(r.page.getByRole('menuitem', { name: 'Staff reviews' }));
    await r.until(r.page.getByText('Review history').first());
    await r.focus('overall', [`${drawer} [aria-label="Overall rating"]`], { chapter: 'Staff reviews' });
    await r.waitSpeech();
    await r.say('c9-dash');
    await r.press('Escape');
    await r.wide('calendar', { chapter: 'Calendar and dashboard' });
    await r.click(nav('Calendar')); await r.hold(1.6);
    await r.click(nav('Dashboard'));
    await r.until('.dash-counts dd'); await r.hold(1.8);
    await r.focus('hours', ['.dash-hours']); await r.hold(1.4);
    await r.focus('ready', ['.dash-readiness .dash-card-head', '.dash-readiness .dash-stages']);
    await r.waitSpeech();
  },
});

// boot: the route loaded in real time before the clock is paused (`ready` = what must be on screen first); the script
// then works inside the app, so every reveal and transition after that happens on the stepped clock.
const PLAN = {
  'dashboard-cinematic-sample': { persona: 'manager', boot: '/help' },
  'dashboard-cinematic': { persona: 'manager', boot: '/help' },
  'overview-tour': { persona: 'manager', boot: '/' },
  'sidebar-shortcuts': { persona: 'manager', boot: '/' },
  'create-workspace': { persona: 'newManager', boot: '/', ready: '#ws-name' },
  'invite-manager': { persona: 'ceo', boot: '/users' },
  'add-staff': { persona: 'manager', boot: '/users' },
  'assign-venue-manager-staff': { persona: 'manager', boot: '/' },
  'staff-reviews': { persona: 'manager', boot: '/' },
  'create-venue': { persona: 'manager', boot: '/venues' },
  'create-shift-send-offers': { persona: 'manager', boot: '/shifts' },
  'venue-request-approval': { persona: 'manager', boot: '/' },
  'confirm-offers': { persona: 'manager', boot: '/offers' },
  'staffing-pipeline': { persona: 'manager', boot: '/' },
  // Introduction film (narration: tools/narration/build/crewflow-introduction). clockAt = the story moment on screen.
  'intro-web-console': { persona: 'manager', boot: '/help', narration: 'crewflow-introduction', mutate: story.request, clockAt: '2026-10-20T08:40:00Z' },
  'intro-web-team': { persona: 'manager', boot: '/', narration: 'crewflow-introduction', mutate: story.request, clockAt: '2026-10-19T14:10:00Z' },
  'intro-web-approve': { persona: 'manager', boot: '/', narration: 'crewflow-introduction', mutate: story.request, clockAt: '2026-10-20T09:30:00Z' },
  'intro-web-board': { persona: 'manager', boot: '/venue-offers/vr-river-wedding', ready: '.pipeline-board', narration: 'crewflow-introduction', mutate: story.offered, clockAt: '2026-10-20T11:05:00Z' },
  'intro-web-confirm': { persona: 'manager', boot: '/offers', narration: 'crewflow-introduction', clockAt: '2026-10-20T11:10:00Z' },
  'intro-web-after': { persona: 'manager', boot: '/', narration: 'crewflow-introduction', mutate: story.done, clockAt: '2026-10-23T17:55:00Z' },
};

(async () => {
  const cfg = PLAN[SLUG];
  if (!cfg) { console.error(`unknown slug ${SLUG}; known: ${Object.keys(PLAN).join(', ')}`); process.exit(2); }
  const browser = await launch();
  const { context, page, errors, fx } = await openPage(browser, { persona: cfg.persona, viewport: VIEWPORT, deviceScaleFactor: DPR, reducedMotion: cfg.reducedMotion || 'no-preference', latencyMs: 120, mutate: cfg.mutate });
  await context.addInitScript(CURSOR_SCRIPT);
  // framer-motion hands opacity/transform animations to the browser's Web Animations engine when it exists; those run on
  // the compositor's real-time timeline, not on the stepped JS clock, so a drawer's fade can be left half-finished in the
  // frames. Without Element.prototype.animate, framer-motion runs the SAME animations (same durations and easing) on its
  // main-thread engine, which follows the stepped clock. Capture-only; the app's code and CSS are untouched (the app has
  // no direct Element.animate calls).
  await context.addInitScript(() => { delete Element.prototype.animate; });
  // clockAt pins the page's clock to a story moment (greeting, "today", relative times) without touching the data.
  await page.clock.install(cfg.clockAt ? { time: new Date(cfg.clockAt) } : undefined);
  const cdp = await context.newCDPSession(page);
  const r = new SteppedRecorder(SLUG, page, cdp, cfg.narration || SLUG);
  let failure = null;
  const started = Date.now();
  try {
    await page.goto(APP_ORIGIN + cfg.boot);
    await page.locator(cfg.ready || 'aside.sidebar').first().waitFor();
    await page.waitForTimeout(1500);
    await page.mouse.move(r.mouse.x, r.mouse.y);
    await r.start();
    await SCRIPTS[SLUG](r, { browser, fx });
  } catch (err) { failure = err.message.split('\n')[0]; }
  const res = await r.finish().catch((e) => { failure = failure || e.message; return { frames: r.n, seconds: r.now() }; });
  if (fx.unhandled.length) failure = failure || `fixture gaps: ${fx.unhandled.join(', ')}`;
  fs.writeFileSync(path.join(r.dir, 'run.json'), JSON.stringify({ slug: SLUG, persona: cfg.persona, boot: cfg.boot, origin: APP_ORIGIN, viewport: VIEWPORT, dpr: DPR, fps: FPS, capture: 'Playwright clock-stepped device-pixel screenshots', recordedAt: new Date().toISOString(), realSeconds: Math.round((Date.now() - started) / 1000), fixture: 'tools/web/fixtures.cjs (synthetic, no real API)', unhandled: fx.unhandled, pageErrors: errors, failure }, null, 2));
  console.log(`${failure ? '✗' : '✓'} ${SLUG}: ${res.seconds.toFixed(2)}s, ${res.frames} frames @ ${FPS}fps, ${VIEWPORT.width * DPR}×${VIEWPORT.height * DPR}${failure ? ` — ${failure}` : ''}${errors.length ? ` [pageerror: ${errors.join(' | ')}]` : ''}`);
  await context.close(); await browser.close();
  if (failure || errors.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
