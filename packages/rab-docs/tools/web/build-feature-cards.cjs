#!/usr/bin/env node
// Rebuilds the home-page cover and the six "Key features" cards (light + dark) from the CURRENT Crewflow UI.
//
//   CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node packages/rab-docs/tools/web/build-feature-cards.cjs [--keep <dir>]
//
// 1. Captures fresh web console screens (1440×900 @2x) with the synthetic fixture backend (fixtures.cjs: fictional
//    data, unknown requests fail, other origins blocked), in light and dark themes.
// 2. Composes each card from an HTML template (eyebrow, title, subtitle, a browser frame or phones) and renders it with
//    the same browser, then writes WebP into images/getting-started/. Phone screens reuse the docs' current mobile
//    screenshots (images/mobile/). Nothing is painted over the captured UI.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, openPage, go } = require('./common.cjs');

const DOCS = path.resolve(__dirname, '..', '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(DOCS, 'images', 'getting-started');
const keepIdx = process.argv.indexOf('--keep');
const WORK = keepIdx > -1 ? path.resolve(process.argv[keepIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-cards-'));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
fs.mkdirSync(WORK, { recursive: true });

const SCREENS = {
  dashboard: { route: '/', ready: '.dash-counts dd' },
  users: { route: '/users', ready: 'tbody tr' },
  calendar: { route: '/calendar', ready: '.calendar-grid' },
  offers: { route: '/offers', ready: 'tbody tr' },
  payroll: { route: '/payroll', ready: 'tbody tr' },
};

const CARDS = [
  { name: 'feature-workforce', n: '01', label: 'Workforce', title: 'Workforce Management', sub: 'Staff and manager records, roles and invitations.', screen: 'users' },
  { name: 'feature-scheduling', n: '02', label: 'Scheduling', title: 'Shifts & Calendar', sub: 'Plan shifts by venue, role and time.', screen: 'calendar' },
  { name: 'feature-offers', n: '03', label: 'Offers', title: 'Offers & Confirmation', sub: 'Offer shifts, then confirm the staff who accept.', screen: 'offers' },
  { name: 'feature-attendance', n: '04', label: 'Attendance', title: 'Attendance & QR', sub: 'Clock in and out against server-checked QR and location.', phones: ['clock-ready', 'clock-live'] },
  { name: 'feature-payroll', n: '05', label: 'Payroll', title: 'Payroll & Timesheets', sub: 'Worked hours and earnings from real attendance.', screen: 'payroll', scale: 1.04 },
  { name: 'feature-mobile', n: '06', label: 'Mobile', title: 'Mobile Workforce', sub: 'A Flutter app for staff and venue managers.', phones: ['calendar-today', 'offers-pending', 'home-my-space'] },
];

const uri = (file) => `data:${file.endsWith('.png') ? 'image/png' : 'image/webp'};base64,${fs.readFileSync(file).toString('base64')}`;
const mobile = (name) => uri(path.join(DOCS, 'images', 'mobile', `${name}.webp`));

const THEME = {
  light: { bg: 'linear-gradient(155deg,#fcfbf9 0%,#f4f1ec 100%)', num: '#a8a29e', label: '#ea580c', title: '#1c1917', sub: '#57534e', bar: '#f5f5f4', line: '#e7e5e4', dot: '#d6d3d1', shadow: '0 30px 80px rgba(28,25,23,.16), 0 4px 14px rgba(28,25,23,.08)' },
  dark: { bg: 'linear-gradient(155deg,#1f1b18 0%,#0f0d0b 100%)', num: '#78716c', label: '#fb923c', title: '#fafaf9', sub: '#a8a29e', bar: '#292524', line: '#3a3532', dot: '#57534e', shadow: '0 30px 80px rgba(0,0,0,.55), 0 4px 14px rgba(0,0,0,.35)' },
};

const browserFrame = (t, img, { x, y, w, scale }) => `
  <div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;border-radius:16px 0 0 0;overflow:hidden;box-shadow:${t.shadow};border:1px solid ${t.line};border-right:0;border-bottom:0;background:${t.bar}">
    <div style="height:34px;display:flex;align-items:center;gap:8px;padding-left:16px;background:${t.bar};border-bottom:1px solid ${t.line}">
      <i style="width:11px;height:11px;border-radius:50%;background:${t.dot}"></i><i style="width:11px;height:11px;border-radius:50%;background:${t.dot}"></i><i style="width:11px;height:11px;border-radius:50%;background:${t.dot}"></i>
    </div>
    <img src="${img}" style="display:block;width:${Math.round(1440 * scale)}px;height:auto">
  </div>`;
const phone = (src, { x, y, w }) => `
  <div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;padding:9px;border-radius:${Math.round(w * 0.17)}px;background:#0c0a09;box-shadow:0 26px 60px rgba(0,0,0,.28)">
    <img src="${src}" style="display:block;width:100%;border-radius:${Math.round(w * 0.14)}px">
  </div>`;

function cardHtml(card, theme, shots) {
  const t = THEME[theme];
  let art = '';
  if (card.screen) art = browserFrame(t, shots[`${card.screen}-${theme}`], { x: 86, y: 262, w: 1200, scale: card.scale || 0.86 });
  else {
    const w = card.phones.length === 3 ? 250 : 270;
    const gap = card.phones.length === 3 ? 60 : 110;
    const total = card.phones.length * w + (card.phones.length - 1) * gap;
    art = card.phones.map((p, i) => phone(mobile(p), { x: (1200 - total) / 2 + i * (w + gap), y: 250 + (i % 2) * 30, w })).join('');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;width:1200px;height:800px;overflow:hidden;font-family:Inter,"Segoe UI",system-ui,sans-serif;background:${t.bg};position:relative}
    .eyebrow{position:absolute;left:86px;top:74px;font-size:19px;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
    .eyebrow b{color:${t.num};font-weight:600;margin-right:12px}.eyebrow span{color:${t.label}}
    h1{position:absolute;left:84px;top:104px;margin:0;font-size:54px;font-weight:700;letter-spacing:-.02em;color:${t.title}}
    p{position:absolute;left:86px;top:184px;margin:0;font-size:24px;color:${t.sub}}
  </style></head><body>
    <div class="eyebrow"><b>${card.n}</b><span>${card.label}</span></div><h1>${card.title}</h1><p>${card.sub}</p>${art}
  </body></html>`;
}

function coverHtml(theme, shots) {
  const t = THEME[theme];
  const logo = uri(path.join(DOCS, 'images', 'brand', theme === 'dark' ? 'logo-dark.png' : 'logo-light.png'));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:Inter,"Segoe UI",system-ui,sans-serif;background:${t.bg};position:relative}
    .tag{position:absolute;right:96px;top:84px;font-size:22px;color:${t.sub};letter-spacing:.01em}
  </style></head><body>
    <img src="${logo}" style="position:absolute;left:96px;top:66px;height:64px">
    <div class="tag">Staff · Shifts · Offers · Attendance · Payroll</div>
    ${browserFrame(t, shots[`dashboard-${theme}`], { x: 330, y: 196, w: 1590, scale: 1.12 })}
    ${phone(mobile('calendar-today'), { x: 120, y: 330, w: 330 })}
  </body></html>`;
}

(async () => {
  const browser = await launch();
  try { await build(browser); } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });

async function build(browser) {
  const shots = {};
  for (const theme of ['light', 'dark']) {
    for (const [name, s] of Object.entries(SCREENS)) {
      const { context, page, fx, errors } = await openPage(browser, { persona: 'manager', theme, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await go(page, s.route, 400);
      await page.locator(s.ready).first().waitFor();
      await page.waitForTimeout(name === 'dashboard' ? 2500 : 900);
      await page.mouse.move(1430, 890);
      const file = path.join(WORK, `${name}-${theme}.png`);
      await page.screenshot({ path: file });
      if (fx.unhandled.length || errors.length) throw new Error(`${name}/${theme}: unhandled ${fx.unhandled.join(', ')} errors ${errors.join(' | ')}`);
      shots[`${name}-${theme}`] = uri(file);
      await context.close();
      console.log(`captured ${name}-${theme}`);
    }
  }
  const render = async (html, w, h, name) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    const png = path.join(WORK, `${name}.png`);
    await page.screenshot({ path: png });
    await page.close();
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', path.join(OUT, `${name}.webp`)]);
    console.log(`wrote ${name}.webp`);
  };
  for (const theme of ['light', 'dark']) {
    for (const card of CARDS) await render(cardHtml(card, theme, shots), 1200, 800, `${card.name}-${theme}`);
    await render(coverHtml(theme, shots), 1920, 1080, `cover-${theme}`);
  }
  console.log(`work files: ${WORK}`);
}
