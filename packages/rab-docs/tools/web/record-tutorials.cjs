#!/usr/bin/env node
// Records tutorial screen recordings of the REAL Crewflow web console (Vite dev server on :5173)
// driven by real UI interaction, with every API response answered by fixtures.cjs.
//
//   node packages/rab-docs/tools/web/record-tutorials.cjs [slug-filter] [--out <dir>]
//
// Each tutorial writes <out>/<slug>/frames/000001.jpg…, frames.json [{file,t}] and
// captions.json [{start,end,text}] (seconds on the same clock as frames.json). Frames come from
// the Chrome DevTools Protocol screencast (1600×900 JPEG), which only emits on visual change —
// frames are timestamped, not evenly spaced; assemble them with their timestamps.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN, drawer } = require('./common.cjs');
const { generatedPng } = require('./fixtures.cjs');

const argOut = process.argv.indexOf('--out');
const OUT_ROOT = argOut > -1 ? path.resolve(process.argv[argOut + 1]) : path.join(require('os').tmpdir(), 'rab-docs-recordings');
const VIEWPORT = { width: 1600, height: 900 };
// Narrated tutorials: segments synthesised by tools/narration/synthesize.ps1 (tools/narration/build/<slug>/segments.json).
const NARRATION_ROOT = path.resolve(__dirname, '..', 'narration', 'build');
const SPEECH_GAP_S = 0.45; // breathing room between two spoken lines

// Visible fake cursor + click ripple (the headless browser draws no pointer of its own).
const CURSOR_SCRIPT = () => {
  const install = () => {
    if (document.getElementById('__doc-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `#__doc-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(800px,450px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));}
      .__doc-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(121,84,58,.85);background:rgba(121,84,58,.18);animation:__doc-r .55s ease-out forwards}
      @keyframes __doc-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.25);opacity:0}}`;
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__doc-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.6 L11.7 15.2 L18.6 15.2 Z" fill="#1d1b19" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const pos = window.__docCursorPos || { x: 800, y: 450 };
    c.style.transform = `translate(${pos.x}px,${pos.y}px)`;
    window.addEventListener('mousemove', (e) => { window.__docCursorPos = { x: e.clientX, y: e.clientY }; c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__doc-ripple'; r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
};

class Recorder {
  constructor(slug) {
    this.slug = slug;
    this.dir = path.join(OUT_ROOT, slug);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true });
    this.frames = [];
    this.captions = [];
    this.n = 0;
    this.mouse = { x: 800, y: 450 };
    this.wallToFrame = 0; // CDP frame timestamp minus Date.now()/1000
    this.cues = [];
    this.speechEnd = 0;
    const seg = path.join(NARRATION_ROOT, slug, 'segments.json');
    this.segments = fs.existsSync(seg) ? Object.fromEntries(JSON.parse(fs.readFileSync(seg, 'utf8')).map((x) => [x.id, x])) : null;
  }
  /**
   * Starts one narration line (and its caption) on the recording clock. It first waits for the previous line to finish,
   * so lines never overlap; the actions that follow happen WHILE the line is spoken. The audio is placed at exactly this
   * moment when the video is composed — the recording is never stretched to fit the voice.
   */
  async say(id) {
    const seg = this.segments && this.segments[id];
    if (!seg) throw new Error(`narration segment missing: ${this.slug}/${id} (run tools/narration/synthesize.ps1 first)`);
    await this.waitSpeech();
    const t = this.now();
    this.cues.push({ id, start: t, seconds: seg.seconds, text: seg.text, file: seg.file });
    this.caption(seg.text);
    this.speechEnd = t + seg.seconds + SPEECH_GAP_S;
  }
  async waitSpeech() { const left = this.speechEnd - this.now(); if (left > 0) await this.page.waitForTimeout(Math.ceil(left * 1000)); }
  async attach(page) {
    if (this.cdp) { await this.cdp.send('Page.stopScreencast').catch(() => {}); await this.cdp.detach().catch(() => {}); }
    this.page = page;
    this.cdp = await page.context().newCDPSession(page);
    this.cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      this.n += 1;
      const file = `frames/${String(this.n).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(this.dir, file), Buffer.from(data, 'base64'));
      this.wallToFrame = metadata.timestamp - Date.now() / 1000;
      this.frames.push({ file, ts: metadata.timestamp });
      await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
    const before = this.n;
    for (let i = 0; i < 40 && this.n === before; i++) { await this.nudge(); await page.waitForTimeout(50); }
  }
  now() { return Date.now() / 1000 + this.wallToFrame; }
  async nudge() { await this.page.mouse.move(this.mouse.x + 1, this.mouse.y); await this.page.mouse.move(this.mouse.x, this.mouse.y); }
  caption(text) {
    const t = this.now();
    const last = this.captions[this.captions.length - 1];
    if (last && last.end == null) last.end = t;
    this.captions.push({ start: t, end: null, text });
  }
  endCaption() { const last = this.captions[this.captions.length - 1]; if (last && last.end == null) last.end = this.now(); }
  pause(ms = 1000) { return this.page.waitForTimeout(ms); }
  async moveTo(target, { dx = 0, dy = 0 } = {}) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible' });
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    const x = Math.round(box.x + Math.min(box.width / 2, 60) + dx);
    const y = Math.round(box.y + box.height / 2 + dy);
    await this.page.mouse.move(x, y, { steps: 25 });
    this.mouse = { x, y };
    await this.pause(180);
    return loc;
  }
  async click(target, opts) { const loc = await this.moveTo(target, opts); await this.page.mouse.down(); await this.pause(60); await this.page.mouse.up(); await this.pause(350); return loc; }
  async type(target, text, opts = {}) { const loc = await this.click(target); if (opts.clear) await loc.fill(''); await loc.pressSequentially(text, { delay: 55 }); await this.pause(250); return loc; }
  async select(target, value) { const loc = await this.click(target); await loc.selectOption(value); await this.pause(450); return loc; }
  async fill(target, value) { const loc = await this.click(target); await loc.fill(value); await this.pause(350); return loc; }
  async finish() {
    if (this.cues.length) { await this.waitSpeech(); await this.pause(900); } // final state stays visible after the last line
    this.endCaption();
    await this.nudge();
    await this.pause(700);
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await this.pause(200);
    const t0 = this.frames[0].ts;
    const frames = this.frames.map((f) => ({ file: f.file, t: Number((f.ts - t0).toFixed(3)) }));
    const duration = frames[frames.length - 1].t;
    const captions = this.captions.map((c) => ({ start: Number(Math.max(0, c.start - t0).toFixed(2)), end: Number(Math.min(duration, c.end - t0).toFixed(2)), text: c.text })).filter((c) => c.end > c.start);
    fs.writeFileSync(path.join(this.dir, 'frames.json'), JSON.stringify(frames, null, 1));
    fs.writeFileSync(path.join(this.dir, 'captions.json'), JSON.stringify(captions, null, 2));
    if (this.cues.length) {
      const cues = this.cues.map((c) => ({ id: c.id, start: Number((c.start - t0).toFixed(3)), seconds: c.seconds, text: c.text, file: path.join(NARRATION_ROOT, this.slug, c.file) }));
      fs.writeFileSync(path.join(this.dir, 'cues.json'), JSON.stringify(cues, null, 2));
    }
    return { slug: this.slug, frames: frames.length, duration, captions: captions.length, dir: this.dir };
  }
}

const nav = (label) => `aside.sidebar a.nav-item[aria-label="${label}"]`;
const fld = (label, tag = 'input', scope = drawer) => `${scope} .field:has(> label:text-is("${label}")) ${tag}`;
const ymd = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toLocaleDateString('sv-SE'); };

const tutorials = {
  async 'overview-tour-narrated'(r) {
    await r.say('intro'); await r.pause(1500);
    await r.say('dashboard');
    await r.moveTo('.dash-counts'); await r.pause(2200); await r.moveTo('.dash-hours .dash-card-link');
    await r.say('sidebar');
    await r.moveTo(nav('Dashboard')); await r.pause(1600);
    await r.moveTo('.sidebar-group:has-text("Operations") .sidebar-group-label'); await r.pause(1800);
    await r.moveTo('.sidebar-group:has-text("Workspace") .sidebar-group-label');
    await r.say('users');
    await r.click(nav('Users')); await settle(r.page, 1000);
    await r.say('shifts');
    await r.click(nav('Shifts')); await settle(r.page, 1000);
    await r.say('offers');
    await r.click(nav('Offers')); await settle(r.page, 1000);
    await r.say('venue-offers');
    await r.click(nav('Venue Offers')); await settle(r.page, 1000);
    await r.say('calendar');
    await r.click(nav('Calendar')); await settle(r.page, 1000);
    await r.moveTo('.calendar-day-panel, .calendar-side, aside:not(.sidebar)').catch(() => {});
    await r.say('search');
    await r.page.keyboard.press('/');
    await r.pause(900);
    await r.page.keyboard.type('Ri', { delay: 140 });
    await r.pause(2600);
    await r.page.keyboard.press('Escape');
    await r.say('help');
    await r.click(nav('Help Center')); await settle(r.page, 1000);
  },

  async 'invite-manager-narrated'(r) {
    await r.say('intro'); await r.pause(1500);
    await r.say('open');
    await r.click('button.tab-link:has-text("Managers")'); await settle(r.page, 800);
    await r.say('new');
    await r.click('button:has-text("New manager")'); await r.pause(700);
    await r.say('name');
    await r.type(fld('First name *'), 'Jesse');
    await r.type(fld('Last name *'), 'Clarke');
    await r.say('type');
    await r.moveTo(fld('Manager type', 'select')); await r.pause(900);
    await r.type(fld('Job title'), 'Area manager');
    await r.say('contact');
    await r.type(fld('Email *'), 'jesse.clarke@example.test');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900412');
    await r.say('create');
    await r.click(`${drawer} button:has-text("Create manager")`);
    await r.page.locator(`${drawer} .detail-tabs`).waitFor();
    await r.say('status');
    await r.moveTo(`${drawer} .drawer-header .badge`); await r.pause(1500);
  },

  async 'create-workspace-narrated'(r, { browser }) {
    await r.say('intro'); await r.pause(1200);
    await r.say('logo');
    const [chooser] = await Promise.all([r.page.waitForEvent('filechooser'), r.click('button:has-text("Upload logo")')]);
    await chooser.setFiles({ name: 'northwind-logo.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'logo') });
    await r.say('name');
    await r.type('#ws-name', 'Northwind Staffing');
    await r.page.getByText('is available').waitFor();
    await r.say('address');
    await r.type('#ws-subdomain', 'northwind', { clear: true });
    await r.page.getByText('✓ northwind is available').waitFor(); await r.pause(1200);
    await r.waitSpeech();
    await r.click('button:has-text("Create workspace")');
    await r.page.waitForURL('**/onboarding/profile');
    await r.say('profile');
    const [chooser2] = await Promise.all([r.page.waitForEvent('filechooser'), r.click('button:has-text("Upload photo")')]);
    await chooser2.setFiles({ name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'avatar', 'jordan') });
    await r.type('#p-first', 'Jordan');
    await r.type('#p-last', 'Hale');
    await r.type('#p-title', 'Operations manager');
    await r.waitSpeech();
    await r.click('button:has-text("Complete setup")');
    await r.page.waitForURL('**/onboarding/preparing');
    await r.say('preparing');
    await r.page.locator('.welcome-overlay').waitFor({ timeout: 25000 });
    await r.say('ready');
    await r.page.waitForURL(`${APP_ORIGIN}/`, { timeout: 15000 });
    await settle(r.page, 600);
  },

  async 'create-venue-narrated'(r) {
    await r.say('intro'); await r.pause(1500);
    await r.say('open');
    await r.click('button:has-text("New venue")'); await r.pause(600);
    await r.say('details');
    await r.type(fld('Venue name'), 'Lakeside Pavilion');
    await r.type(fld('Client name'), 'Lakeside Leisure Ltd');
    await r.select(fld('Type', 'select'), 'event');
    await r.say('address');
    await r.type(fld('Address'), '5 Example Parade');
    await r.type(fld('City'), 'Leeds');
    await r.type(fld('Postcode'), 'LS1 9XX');
    await r.say('geofence');
    await r.type('#venue-lat', '53.7965');
    await r.type('#venue-lng', '-1.5478');
    await r.type('#venue-radius', '150', { clear: true });
    await r.click(`${drawer} input[role=switch]`);
    await r.say('break');
    await r.type(fld('Default break minutes'), '30');
    await r.say('create');
    await r.click(`${drawer} button:has-text("Create venue")`);
    await r.page.getByText('+ Add another role rate').waitFor();
    await r.say('rates');
    await r.select(fld('Role', 'select'), { label: 'Event staff' });
    await r.type(fld('Hourly rate (£)'), '14.75');
    await r.click(`${drawer} button:has-text("+ Add another role rate")`);
    await r.page.locator(`${drawer}`).getByText('£14.75/h').waitFor(); await r.pause(700);
    await r.click(`${drawer} button:has-text("Save changes")`);
    await r.say('done');
    await r.moveTo('tr:has-text("Lakeside Pavilion")'); await r.pause(1500);
  },

  async 'create-shift-send-offers-narrated'(r) {
    await r.say('intro'); await r.pause(1500);
    await r.say('open');
    await r.click('button:has-text("New shift")'); await r.pause(700);
    await r.say('venue');
    await r.click(`${drawer} .field:has(> label:text-is("Venue")) button`);
    await r.click('.dropdown-menu .dropdown-item:has-text("Riverside House")');
    await r.click(`${drawer} .field:has(> label:text-is("Role")) button`);
    await r.click('.dropdown-menu .dropdown-item:has-text("Waiting staff")');
    await r.say('time');
    await r.fill(fld('Date'), ymd(1));
    await r.fill(fld('Start time'), '12:00');
    await r.fill(fld('End time'), '18:00');
    await r.type(fld('Break (minutes)'), '30', { clear: true });
    await r.say('staff');
    await r.click(r.page.getByRole('button', { name: 'Select staff' }));
    await r.page.getByRole('heading', { name: 'Select Staff' }).waitFor();
    for (const n of ['Alex Morgan', 'Priya Shah', 'Sam Reed']) await r.click(r.page.getByLabel(`Select ${n}`, { exact: true }));
    await r.pause(500);
    await r.click(r.page.getByRole('button', { name: 'Confirm', exact: true }));
    await r.page.getByRole('heading', { name: 'Select Staff' }).waitFor({ state: 'detached' });
    await r.say('send');
    await r.click(`${drawer} button:has-text("Send Offer")`);
    await r.page.getByText(/Shift created ✓/).waitFor();
    await r.say('result');
    await r.moveTo(`${drawer} p:has-text("Sam Reed")`).catch(() => {});
    await r.pause(1500);
  },

  // ── Narrated (2026-10-20). Each `say` starts one spoken line; the actions after it happen while it is spoken. ──
  async 'add-staff-narrated'(r) {
    await r.say('intro'); await r.pause(1500);
    await r.say('open');
    await r.click('button:has-text("New staff")'); await r.pause(700);
    await r.say('step1');
    await r.type(fld('First name *'), 'Rowan');
    await r.type(fld('Last name *'), 'Price');
    await r.select(fld('Job role', 'select'), { label: 'Bartender' });
    await r.select(fld('Employment type', 'select'), 'Part-time');
    await r.type(fld('Default rate (£/hr)'), '14.50');
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Next")`);
    await r.say('step2');
    await r.type(fld('Email *'), 'rowan.price@example.test');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900345');
    await r.type(fld('City'), 'Bristol');
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Next")`);
    await r.say('step3');
    await r.type(fld('Full name *'), 'Charlie Price');
    await r.type(fld('Relationship *'), 'Sister');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900388');
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Next")`);
    await r.say('step4');
    for (const d of ['Mon', 'Wed', 'Fri', 'Sat']) await r.click(`${drawer} label.weekday-picker-option:has-text("${d}")`);
    await r.select(fld('Preferred shift times', 'select'), 'Evening');
    await r.type(fld('Maximum hours per week'), '30');
    await r.say('create');
    await r.click(`${drawer} button:has-text("Create")`);
    await r.page.locator(`${drawer} .detail-tabs`).waitFor();
    await r.say('result');
    await r.moveTo(`${drawer} .drawer-header .badge`); await r.pause(1500);
  },

  async 'assign-venue-manager-staff'(r) {
    await r.say('intro'); await r.pause(1800);
    await r.say('open');
    await r.click(nav('Users'));
    await r.page.locator('button.tab-link', { hasText: 'Venue managers' }).waitFor();
    await r.click('button.tab-link:has-text("Venue managers")');
    await r.page.locator('tbody tr', { hasText: 'Riley Chen' }).waitFor();
    await r.say('view');
    await r.click('tr:has-text("Riley Chen") button[title="View"]');
    await r.page.locator(drawer).waitFor();
    await r.say('tab');
    await r.click(`${drawer} .detail-tab-more-trigger`);
    await r.pause(600);
    await r.click(r.page.getByRole('menuitem', { name: 'Assigned staff' }));
    await r.page.locator(`${drawer} [aria-label="Assigned staff"] li`).first().waitFor();
    await r.say('list');
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:nth-child(2)`); await r.pause(1500);
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:nth-child(4)`);
    await r.say('add');
    await r.click(r.page.locator(`${drawer} button`, { hasText: 'Add Staff' }).last());
    await r.page.getByRole('heading', { name: 'Select Staff' }).waitFor();
    await r.pause(1200);
    await r.moveTo('tr:has-text("Grace Kim") .badge'); await r.pause(1200);
    await r.say('pick');
    for (const n of ['Isla Moore', 'Kai Turner']) await r.click(r.page.getByLabel(`Select ${n}`, { exact: true }));
    await r.pause(600);
    await r.click(r.page.getByRole('button', { name: 'Confirm', exact: true }));
    await r.page.getByRole('heading', { name: 'Select Staff' }).waitFor({ state: 'detached' });
    await r.say('done');
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:last-child`); await r.pause(1600);
    await r.moveTo(`${drawer} [aria-label="Assigned staff"] li:last-child button`);
  },

  async 'venue-request-approval-narrated'(r) {
    await r.say('intro'); await r.pause(2000);
    await r.say('open');
    await r.click(nav('Venue Offers')); await settle(r.page, 1200);
    await r.moveTo('tr:has-text("Pending approval") .badge');
    await r.say('review');
    await r.click('tr:has-text("Pending approval")');
    await r.page.getByText('Selected staff').waitFor(); await r.pause(1500);
    await r.moveTo(r.page.locator(drawer).getByText('Selected staff'));
    await r.say('gap');
    await r.moveTo(r.page.locator(drawer).getByText(/selected \/ \d+ required/));
    await r.waitSpeech();
    await r.click(`${drawer} button:has-text("Select 2 Staff")`);
    await r.page.locator('.staff-selection-page table').waitFor();
    await r.say('pick');
    await r.click('.staff-selection-page tr:has-text("Leah Fischer")');
    await r.click('.staff-selection-page tr:has-text("Isla Moore")');
    await r.pause(700);
    await r.click('.staff-selection-page button:has-text("Confirm")');
    await r.page.getByText('Staff Complete ✓').waitFor();
    await r.say('approve');
    await r.click(`${drawer} button:has-text("Approve")`);
    await r.page.locator('.pipeline-board').waitFor(); await settle(r.page, 1200);
    await r.say('board');
    await r.moveTo('.pipeline-column.stage-offered'); await r.pause(1500);
  },

  async 'confirm-offers-narrated'(r) {
    await r.say('intro'); await r.pause(1800);
    await r.say('view');
    await r.click('button[aria-label="Offers view"]');
    await r.click('[role=option]:has-text("Awaiting Confirmation")');
    await settle(r.page, 1200);
    await r.say('row');
    await r.moveTo('tr:has-text("Priya Shah") .muted');
    await r.say('one');
    await r.click('tr:has-text("Priya Shah") button[title="Confirm shift"]');
    await r.pause(2600);
    await r.click(`${drawer} button:has-text("Confirm shift")`);
    await settle(r.page, 1000);
    await r.say('all');
    await r.click('button:has-text("Confirm All Accepted")');
    await settle(r.page, 1200);
    await r.say('confirmed');
    await r.click('button[aria-label="Offers view"]');
    await r.click('[role=option]:has-text("Confirmed")');
    await settle(r.page, 1200);
    await r.moveTo('tr:has-text("Daniel Okafor") .badge');
  },

  async 'staffing-pipeline'(r) {
    await r.say('intro'); await r.pause(1800);
    await r.say('open');
    await r.click(nav('Venue Offers')); await settle(r.page, 1200);
    await r.click('tr:has-text("The Grand Hall")');
    await r.page.locator('.pipeline-board').waitFor(); await settle(r.page, 1200);
    await r.say('summary');
    await r.moveTo(r.page.getByText('Required', { exact: true }).first()); await r.pause(2200);
    await r.moveTo(r.page.getByText('Offered', { exact: true }).first());
    await r.say('lanes');
    // Scroll the board sideways in visible steps so every lane is shown at normal speed.
    for (let i = 0; i < 8; i++) { await r.page.locator('.pipeline-board').evaluate((el) => el.scrollBy({ left: 380, behavior: 'smooth' })); await r.pause(1500); }
    await r.say('card');
    await r.moveTo('.pipeline-column.stage-clocked-in .pipeline-card, .pipeline-board [class*="clocked-in"] article', {}).catch(() => {});
    await r.pause(1500);
    await r.say('back');
    await r.click('a.pipeline-back'); await settle(r.page, 1200);
    await r.click('tr:has-text("Harbour Kitchen"):has-text("Fully filled")');
    await r.page.locator('.pipeline-board').waitFor(); await settle(r.page, 1200);
    await r.say('report');
    await r.click('button:has-text("Timesheet report")');
    await r.page.locator(`${drawer} .pipeline-report-files`).waitFor();
    await r.say('drawer');
    await r.moveTo(`${drawer} section:has-text("Original Timesheet")`); await r.pause(3000);
    await r.moveTo(`${drawer} section:has-text("Venue Signed Timesheet")`); await r.pause(2500);
    await r.moveTo(`${drawer} .pipeline-report-table`);
  },

  async 'staff-reviews'(r) {
    await r.say('intro'); await r.pause(1800);
    await r.say('open');
    await r.click(nav('Users')); await settle(r.page, 1000);
    await r.click('tr:has-text("Alex Morgan") button[title="View"]');
    await r.page.locator(drawer).waitFor();
    await r.say('tab');
    await r.click(`${drawer} .detail-tab-more-trigger`);
    await r.pause(600);
    await r.click(r.page.getByRole('menuitem', { name: 'Staff reviews' }));
    await r.page.getByText('Review history').first().waitFor();
    await r.say('overall');
    await r.moveTo(`${drawer} [aria-label="Overall rating"]`);
    await r.say('categories');
    await r.moveTo(`${drawer} [aria-label="Average scores"]`);
    await r.say('filter');
    await r.moveTo(r.page.locator(drawer).getByText('All venue managers').first()); await r.pause(1600);
    await r.click(r.page.locator(`${drawer} .sr-range-row button`).first()); await r.pause(700);
    await r.click(r.page.getByRole('option', { name: 'This month' }).or(r.page.locator('.list-view-option', { hasText: 'This month' })).first());
    await settle(r.page, 800);
    await r.say('history');
    await r.moveTo(r.page.locator(drawer).getByText('Review history')); await r.pause(1600);
    await r.click(r.page.locator(`${drawer} button`, { hasText: 'View review' }).first());
    await r.page.getByText('Staff performance').waitFor();
    await r.say('detail');
    await r.moveTo(r.page.locator(drawer).getByText('Staff performance')); await r.pause(2500);
    await r.moveTo(r.page.locator(drawer).getByText('Written feedback'));
  },

  async 'sidebar-shortcuts'(r) {
    await r.say('intro'); await r.pause(1800);
    await r.say('plus');
    await r.click('button[aria-label="Add menu item"]');
    await r.page.locator('.add-menu').waitFor();
    await r.say('kinds');
    for (const k of ['Object', 'View', 'Record', 'Folder', 'Link']) { await r.moveTo(`.add-menu-row:has-text("${k}")`); await r.pause(700); }
    await r.say('choose');
    await r.click('.add-menu-row:has-text("View")'); await r.pause(800);
    await r.click('.add-menu-row:has-text("Offers · Pending")'); await r.pause(800);
    await r.say('confirm');
    await r.type('#add-menu-name', ' (mine)');
    await r.click('.add-menu-icons button[aria-label="star"]');
    await r.pause(600);
    await r.click('.add-menu-actions button:has-text("Add")');
    await r.page.locator('.shortcut-list').waitFor();
    await r.say('result');
    await r.moveTo('.shortcut-list .shortcut-item'); await r.pause(2200);
    await r.say('manage');
    await r.click('.shortcut-list button.shortcut-more'); await r.pause(1800);
    await r.page.keyboard.press('Escape');
  },

  // Narrated. Shows the genuine first-load reveal, an intentional return replaying it, and a real background refresh
  // (one realtime event -> the app's own refetch, verified by the fixture's request counter) that does NOT replay it.
  async 'dashboard-tour'(r, { fx }) {
    await r.say('intro');
    await r.pause(2500);
    await r.moveTo(nav('Dashboard'));
    await r.say('open');
    await r.waitSpeech();
    await r.click(nav('Dashboard'));
    await r.say('reveal'); // the reveal plays while this line starts: hold still and let it run at normal speed
    await r.page.locator('.dash-counts dd').first().waitFor();
    await r.waitSpeech();
    await r.say('strip');
    await r.moveTo('.dash-strip-item:nth-child(1)'); await r.pause(2600);
    await r.moveTo('.dash-strip-item:nth-child(2)'); await r.pause(2000);
    await r.moveTo('.dash-strip-item.is-fixed');
    await r.say('counts');
    await r.moveTo('.dash-counts > div:nth-child(1)'); await r.pause(1800);
    await r.moveTo('.dash-counts > div:nth-child(2)'); await r.pause(1800);
    await r.moveTo('.dash-counts > div:nth-child(3)');
    await r.say('hours');
    await r.moveTo('.dash-hours .dash-big'); await r.pause(3500);
    await r.moveTo('.dash-hours .dash-bar-col:nth-child(6)'); await r.pause(2200);
    await r.moveTo('.dash-hours .dash-bar-col:nth-child(7)');
    await r.say('venues');
    await r.moveTo('.dash-venues .dash-hbars');
    await r.say('readiness');
    await r.moveTo('.dash-readiness .dash-stages'); await r.pause(3000);
    await r.moveTo('.dash-readiness .dash-checklist ul');
    await r.say('lower');
    await r.moveTo('.dash-pipeline .dash-big'); await r.pause(3800);
    await r.moveTo('.dash-week-card .dash-week-grid');
    await r.say('users');
    await r.click(nav('Users'));
    await r.page.locator('button.tab-link', { hasText: 'Venue managers' }).waitFor();
    await r.pause(1200);
    await r.click('button.tab-link:has-text("Venue managers")');
    await r.page.locator('table tbody tr').first().waitFor();
    await r.moveTo('table tbody tr:nth-child(2)');
    await r.waitSpeech();
    await r.say('back');
    await r.pause(900);
    await r.click(nav('Dashboard'));
    await r.page.locator('.dash-counts dd').first().waitFor();
    await r.waitSpeech();
    const before = fx.state.summaryCalls || 0;
    await r.say('refresh');
    await r.pause(4200);
    fx.push('offer.accepted'); // a real server-sent event; the app invalidates and refetches the summary itself
    await r.pause(2500);
    if ((fx.state.summaryCalls || 0) <= before) throw new Error('background refresh did not happen (summary not refetched)');
    await r.moveTo('.dash-counts');
    await r.say('honest');
    await r.moveTo('.dash-counts > div:nth-child(2)');
    await r.say('outro');
    await r.moveTo('.dash-hours .dash-card-link'); await r.pause(1200);
  },

  async 'overview-tour'(r) {
    r.caption('The dashboard shows your staff, offers and venues at a glance.');
    await r.pause(2600);
    await r.moveTo('.stats-grid'); await r.pause(900);
    r.caption('Users lists your staff and managers.');
    await r.click(nav('Users')); await settle(r.page, 2000);
    r.caption('Venues holds every site you staff, with its address and pay rates.');
    await r.click(nav('Venues')); await settle(r.page, 2000);
    r.caption('Shifts shows every shift, how many places are filled and its status.');
    await r.click(nav('Shifts')); await settle(r.page, 2000);
    r.caption('Offers tracks each offer you have sent and how staff responded.');
    await r.click(nav('Offers')); await settle(r.page, 2000);
    r.caption('The calendar shows the month ahead. Select a day to see its shifts.');
    await r.click(nav('Calendar')); await settle(r.page, 800);
    const d = new Date(); d.setDate(d.getDate() + 1);
    await r.click(`button.calendar-cell[aria-label^="${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}"]`);
    await r.moveTo('.calendar-day-events article'); await r.pause(1800);
    r.caption('Payroll lists worked hours and earnings from completed attendance.');
    await r.click(nav('Payroll')); await settle(r.page, 2000);
    await r.moveTo('.list-footer .record-calculation'); await r.pause(1600);
  },

  async 'invite-manager'(r) {
    r.caption('Open Users and switch to the Managers tab.');
    await r.pause(1000);
    await r.click('button.tab-link:has-text("Managers")'); await settle(r.page, 800);
    r.caption('Managers can be internal managers or venue managers.');
    await r.moveTo('table tbody tr:first-child .badge-admin'); await r.pause(1600);
    r.caption('Select New manager.');
    await r.click('button:has-text("New manager")'); await r.pause(700);
    r.caption('Enter their name.');
    await r.type(fld('First name *'), 'Jesse');
    await r.type(fld('Last name *'), 'Clarke');
    r.caption('Keep Internal manager as the type and add a job title.');
    await r.moveTo(fld('Manager type', 'select')); await r.pause(900);
    await r.type(fld('Job title'), 'Area manager');
    r.caption('Add their work email and mobile number. They receive an invitation by email.');
    await r.type(fld('Email *'), 'jesse.clarke@example.test');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900412');
    await r.pause(600);
    r.caption('Select Create manager. Crewflow queues the invitation and opens their details.');
    await r.click(`${drawer} button:has-text("Create manager")`);
    await r.page.locator(`${drawer} .detail-tabs`).waitFor();
    await r.pause(1500);
    r.caption('Their status shows the invitation until they set a password and activate the account.');
    await r.moveTo(`${drawer} .drawer-header .badge`); await r.pause(3600);
  },

  async 'create-workspace'(r, { browser }) {
    r.caption('After your first sign-in, create your workspace.');
    await r.pause(1500);
    r.caption('Upload a logo (PNG, JPG or WEBP).');
    const [chooser] = await Promise.all([r.page.waitForEvent('filechooser'), r.click('button:has-text("Upload logo")')]);
    await chooser.setFiles({ name: 'northwind-logo.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'logo') });
    await r.pause(900);
    r.caption('Type the workspace name. The address fills in from the name.');
    await r.type('#ws-name', 'Northwind Staffing');
    await r.page.getByText('is available').waitFor(); await r.pause(1300);
    r.caption('You can shorten the address. Crewflow checks it is available.');
    await r.type('#ws-subdomain', 'northwind', { clear: true });
    await r.page.getByText('✓ northwind is available').waitFor(); await r.pause(1500);
    await r.click('button:has-text("Create workspace")');
    await r.page.waitForURL('**/onboarding/profile'); await r.pause(800);
    r.caption('Next, create your profile so your team knows who you are.');
    const [chooser2] = await Promise.all([r.page.waitForEvent('filechooser'), r.click('button:has-text("Upload photo")')]);
    await chooser2.setFiles({ name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(browser, 'avatar', 'jordan') });
    await r.pause(600);
    await r.type('#p-first', 'Jordan');
    await r.type('#p-last', 'Hale');
    await r.type('#p-title', 'Operations manager');
    r.caption('Select Complete setup.');
    await r.click('button:has-text("Complete setup")');
    await r.page.waitForURL('**/onboarding/preparing');
    r.caption('Crewflow prepares your workspace. This takes a few seconds.');
    await r.page.locator('.welcome-overlay').waitFor({ timeout: 25000 });
    r.caption('Your workspace is ready.');
    await r.page.waitForURL(`${APP_ORIGIN}/`, { timeout: 15000 });
    await settle(r.page, 600);
    r.caption('You land on your dashboard.');
    await r.pause(2200);
  },

  async 'add-staff'(r) {
    r.caption('On Users, select New staff.');
    await r.pause(1000);
    await r.click('button:has-text("New staff")'); await r.pause(700);
    r.caption('Step 1: personal and employment details.');
    await r.type(fld('First name *'), 'Rowan');
    await r.type(fld('Last name *'), 'Price');
    await r.select(fld('Job role', 'select'), { label: 'Bartender' });
    await r.select(fld('Employment type', 'select'), 'Part-time');
    await r.type(fld('Default rate (£/hr)'), '14.50');
    await r.click(`${drawer} button:has-text("Next")`);
    r.caption('Step 2: contact details. The invitation goes to this email.');
    await r.type(fld('Email *'), 'rowan.price@example.test');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900345');
    await r.type(fld('City'), 'Bristol');
    await r.click(`${drawer} button:has-text("Next")`);
    r.caption('Step 3: an emergency contact.');
    await r.type(fld('Full name *'), 'Charlie Price');
    await r.type(fld('Relationship *'), 'Sister');
    await r.type(`${drawer} input.PhoneInputInput`, '07700 900388');
    await r.click(`${drawer} button:has-text("Next")`);
    r.caption('Step 4: availability.');
    for (const d of ['Mon', 'Wed', 'Fri', 'Sat']) await r.click(`${drawer} label.weekday-picker-option:has-text("${d}")`);
    await r.select(fld('Preferred shift times', 'select'), 'Evening');
    await r.type(fld('Maximum hours per week'), '30');
    r.caption('Select Create. Crewflow creates the account and queues an invitation email.');
    await r.click(`${drawer} button:has-text("Create")`);
    await r.page.locator(`${drawer} .detail-tabs`).waitFor();
    await r.pause(1200);
    r.caption('Their details open. The status shows the invitation until they activate.');
    await r.moveTo(`${drawer} .drawer-header .badge`); await r.pause(2800);
  },

  async 'create-venue'(r) {
    r.caption('On Venues, select New venue.');
    await r.pause(1000);
    await r.click('button:has-text("New venue")'); await r.pause(600);
    r.caption('Enter the venue name, client and type.');
    await r.type(fld('Venue name'), 'Lakeside Pavilion');
    await r.type(fld('Client name'), 'Lakeside Leisure Ltd');
    await r.select(fld('Type', 'select'), 'event');
    r.caption('Add the address.');
    await r.type(fld('Address'), '5 Example Parade');
    await r.type(fld('City'), 'Leeds');
    await r.type(fld('Postcode'), 'LS1 9XX');
    r.caption('Set the location and geofence radius used for clocking in.');
    await r.type('#venue-lat', '53.7965');
    await r.type('#venue-lng', '-1.5478');
    await r.type('#venue-radius', '150', { clear: true });
    await r.click(`${drawer} input[role=switch]`);
    r.caption('Set the default break.');
    await r.type(fld('Default break minutes'), '30');
    r.caption('Select Create venue. The drawer stays open so you can add pay rates.');
    await r.click(`${drawer} button:has-text("Create venue")`);
    await r.page.getByText('+ Add another role rate').waitFor(); await r.pause(900);
    r.caption('Add an hourly rate for a role at this venue.');
    await r.select(fld('Role', 'select'), { label: 'Event staff' });
    await r.type(fld('Hourly rate (£)'), '14.75');
    await r.click(`${drawer} button:has-text("+ Add another role rate")`);
    await r.page.locator(`${drawer}`).getByText('£14.75/h').waitFor(); await r.pause(1200);
    r.caption('Select Save changes.');
    await r.click(`${drawer} button:has-text("Save changes")`);
    await r.pause(1200);
    r.caption('The new venue appears in the list.');
    await r.moveTo('tr:has-text("Lakeside Pavilion")'); await r.pause(2200);
  },

  async 'create-shift-send-offers'(r) {
    r.caption('On Shifts, select New shift.');
    await r.pause(1000);
    await r.click('button:has-text("New shift")'); await r.pause(700);
    r.caption('Choose the venue and role. The address fills in from the venue.');
    await r.click(`${drawer} .field:has(> label:text-is("Venue")) button`);
    await r.type('.dropdown-menu .side-panel-input input', 'River');
    await r.click('.dropdown-menu .dropdown-item:has-text("Riverside House")');
    await r.click(`${drawer} .field:has(> label:text-is("Role")) button`);
    await r.click('.dropdown-menu .dropdown-item:has-text("Waiting staff")');
    r.caption('Set the date, start and end times and the break.');
    await r.fill(fld('Date'), ymd(1));
    await r.fill(fld('Start time'), '12:00');
    await r.fill(fld('End time'), '18:00');
    await r.type(fld('Break (minutes)'), '30', { clear: true });
    r.caption('Select the staff to offer the shift to.');
    const search = `${drawer} .field:has(> label:text-is("Staff members (select one or more)")) .side-panel-input input`;
    for (const [q, name] of [['Alex', 'Alex Morgan'], ['Priya', 'Priya Shah'], ['Sam', 'Sam Reed']]) {
      await r.type(search, q, { clear: true });
      await r.click(`${drawer} .dropdown-item:has-text("${name}")`);
    }
    await r.pause(600);
    r.caption('Select Send Offer. Crewflow creates the shift and sends each offer.');
    await r.click(`${drawer} button:has-text("Send Offer")`);
    await r.page.getByText(/Shift created ✓/).waitFor();
    await r.pause(900);
    r.caption('Two offers were sent. Sam Reed already has a confirmed shift at that time, so no offer was sent.');
    await r.moveTo(`${drawer} p:has-text("Sam Reed")`); await r.pause(3500);
  },

  async 'confirm-offers'(r) {
    r.caption('On Offers, open the view menu.');
    await r.pause(1700);
    await r.click('button[aria-label="Offers view"]');
    r.caption('Choose Awaiting Confirmation to see offers staff have accepted.');
    await r.click('[role=option]:has-text("Awaiting Confirmation")');
    await settle(r.page, 1700);
    r.caption('Each row shows when the staff member accepted.');
    await r.moveTo('tr:has-text("Priya Shah") .muted'); await r.pause(2500);
    r.caption('Confirm one offer with the tick.');
    await r.click('tr:has-text("Priya Shah") button[title="Confirm shift"]');
    await r.pause(1900);
    r.caption('Check the details, then select Confirm shift.');
    await r.click(`${drawer} button:has-text("Confirm shift")`);
    await settle(r.page, 1800);
    r.caption('To confirm everyone else at once, select Confirm All Accepted.');
    await r.click('button:has-text("Confirm All Accepted")');
    await settle(r.page, 2100);
    r.caption('Switch the view to Confirmed to see the updated statuses.');
    await r.click('button[aria-label="Offers view"]');
    await r.click('[role=option]:has-text("Confirmed")');
    await settle(r.page, 1700);
    await r.moveTo('tr:has-text("Daniel Okafor") .badge'); await r.pause(3300);
  },

  async 'venue-request-approval'(r) {
    r.caption('Venue managers send shift requests. Open Offers, then Venue Offers.');
    await r.pause(1700);
    await r.click('a.tab-link:has-text("Venue Offers")'); await settle(r.page, 1700);
    r.caption('Requests pending approval need your review.');
    await r.moveTo('tr:has-text("Pending approval") .badge'); await r.pause(2000);
    r.caption('Open the request that is pending approval.');
    await r.click('tr:has-text("Pending approval")');
    await r.page.getByText('Selected staff').waitFor(); await r.pause(2200);
    r.caption('The venue manager picked two staff. Two places are still open.');
    await r.moveTo(r.page.locator(drawer).getByText(/selected \/ \d+ required/)); await r.pause(1900);
    r.caption('Select staff to fill the open places.');
    await r.click(`${drawer} button:has-text("Select 2 Staff")`);
    await r.page.locator('.staff-selection-page table').waitFor(); await r.pause(900);
    await r.click('.staff-selection-page tr:has-text("Leah Fischer")');
    await r.click('.staff-selection-page tr:has-text("Isla Moore")');
    r.caption('Select Confirm to save the selection.');
    await r.click('.staff-selection-page button:has-text("Confirm")');
    await r.page.getByText('Staff Complete ✓').waitFor(); await r.pause(1900);
    r.caption('All places are filled. Select Approve to send offers to the selected staff.');
    await r.click(`${drawer} button:has-text("Approve")`);
    await r.page.locator('.pipeline-board').waitFor(); await settle(r.page, 1700);
    r.caption('The live pipeline opens, with the new offers in the Offered column.');
    await r.moveTo('.pipeline-column.stage-offered'); await r.pause(3500);
  },

  async 'timesheets-review'(r) {
    r.caption('On Venue Offers, open an approved request to see its live pipeline.');
    await r.pause(1700);
    await r.click('tr:has-text("The Grand Hall")');
    await r.page.locator('.pipeline-board').waitFor(); await settle(r.page, 1800);
    r.caption('Each column shows where staff are, from offered through to clocked out.');
    await r.moveTo('.pipeline-column.stage-clocked-in'); await r.pause(2900);
    r.caption('Return to Venue Offers and open yesterday’s completed request.');
    await r.click('a.pipeline-back');
    await settle(r.page, 1600);
    await r.click('tr:has-text("Harbour Kitchen"):has-text("Fully filled")');
    await r.page.locator('.pipeline-board').waitFor(); await settle(r.page, 1800);
    r.caption('Everyone has clocked out, so the timesheet report is ready.');
    await r.click('button:has-text("Timesheet Report")');
    await r.page.locator(`${drawer} .pipeline-report-files`).waitFor(); await r.pause(2200);
    await r.moveTo(`${drawer} .pipeline-report-table`); await r.pause(2200);
    r.caption('Select View to open the venue-signed timesheet.');
    const [popup] = await Promise.all([r.page.context().waitForEvent('page'), r.click(`${drawer} section:has-text("Venue Signed Timesheet") button:has-text("View")`)]);
    await popup.waitForLoadState('load').catch(() => {});
    await popup.waitForTimeout(1200);
    r.mouse = { x: 800, y: 450 };
    await r.attach(popup);
    r.caption('The PDF opens in a new tab, ready to check, download or print.');
    await popup.waitForTimeout(4500);
  },

  async 'payroll-review'(r) {
    r.caption('Payroll lists hours and earnings from attendance.');
    await r.pause(3400);
    r.caption('Each row is one staff member’s attendance, with hours and amount earned.');
    await r.moveTo('table.payroll-table tbody tr td:nth-child(5)'); await r.pause(2600);
    r.caption('Open the Completed tab for finished shifts.');
    await r.click('button.tab-link:has-text("Completed")'); await settle(r.page, 1800);
    r.caption('Use Filter to narrow the list. Add a Venue filter and choose a venue.');
    await r.click('button.toolbar-btn:has-text("Filter")');
    await r.select('select[aria-label="Add filter"]', 'venueId');
    await r.select('select[aria-label="Venue"]', { label: 'Harbour Kitchen' });
    await r.pause(1500);
    await settle(r.page, 1600);
    await r.page.keyboard.press('Escape'); await r.pause(600);
    r.caption('The footer totals the hours and pay for the records shown.');
    await r.moveTo('.list-footer .record-calculation span'); await r.pause(2500);
    await r.click('.list-footer .record-calculation button'); await r.pause(2900);
  },
};

const PLAN = [
  // Narrated: [slug, { …, run: tutorial function name }]
  ['add-staff', { persona: 'manager', route: '/users', run: 'add-staff-narrated' }],
  ['assign-venue-manager-staff', { persona: 'manager', route: '/' }],
  ['venue-request-approval', { persona: 'manager', route: '/', run: 'venue-request-approval-narrated' }],
  ['confirm-offers', { persona: 'manager', route: '/offers', run: 'confirm-offers-narrated' }],
  ['staffing-pipeline', { persona: 'manager', route: '/' }],
  ['staff-reviews', { persona: 'manager', route: '/' }],
  ['sidebar-shortcuts', { persona: 'manager', route: '/' }],
  ['dashboard-tour', { persona: 'manager', route: '/help', realtime: true }],
  ['overview-tour', { persona: 'manager', route: '/', run: 'overview-tour-narrated' }],
  ['invite-manager', { persona: 'ceo', route: '/users', run: 'invite-manager-narrated' }],
  ['create-workspace', { persona: 'newManager', route: '/', run: 'create-workspace-narrated' }],
  ['create-venue', { persona: 'manager', route: '/venues', run: 'create-venue-narrated' }],
  ['create-shift-send-offers', { persona: 'manager', route: '/shifts', run: 'create-shift-send-offers-narrated' }],
  ['timesheets-review', { persona: 'manager', route: '/venue-offers' }],
  ['payroll-review', { persona: 'manager', route: '/payroll' }],
];

(async () => {
  const filter = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : '';
  const browser = await launch();
  const results = [];
  for (const [slug, cfg] of PLAN.filter(([s]) => !filter || s.includes(filter))) {
    const { context, page, errors, fx } = await openPage(browser, { persona: cfg.persona, viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'no-preference', latencyMs: 120, realtime: !!cfg.realtime });
    await context.addInitScript(CURSOR_SCRIPT);
    await page.goto(APP_ORIGIN + cfg.route);
    await settle(page, 600);
    if (cfg.route === '/' && cfg.persona === 'newManager') await page.waitForURL('**/onboarding/workspace');
    const r = new Recorder(slug);
    let failure = null;
    try {
      await r.attach(page);
      await r.pause(300);
      await tutorials[cfg.run || slug](r, { browser, fx });
    } catch (err) { failure = err.message.split('\n')[0]; }
    const res = await r.finish();
    if (fx.unhandled.length) failure = failure || `fixture gaps: ${fx.unhandled.join(', ')}`;
    results.push({ ...res, failure, pageErrors: errors, summaryCalls: fx.state.summaryCalls || 0 });
    fs.writeFileSync(path.join(r.dir, 'run.json'), JSON.stringify({ slug, persona: cfg.persona, route: cfg.route, origin: APP_ORIGIN, viewport: VIEWPORT, recordedAt: new Date().toISOString(), fixture: 'tools/web/fixtures.cjs (synthetic, no real API)', unhandled: fx.unhandled, pageErrors: errors, dashboardSummaryRequests: fx.state.summaryCalls || 0, failure }, null, 2));
    console.log(`${failure ? '✗' : '✓'} ${slug}: ${res.duration.toFixed(1)}s, ${res.frames} frames, ${res.captions} captions${failure ? ` — ${failure}` : ''}${errors.length ? ` [pageerror: ${errors.join(' | ')}]` : ''}`);
    await context.close();
  }
  await browser.close();
  if (results.some((x) => x.failure || x.pageErrors.length)) process.exitCode = 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
