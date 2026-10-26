// U5 side-by-side (owner approval 2026-10-26): the owner's chat mockup states 4 Approval and 5 Question (left) and Crewflow's
// REAL rab-front with fictional fixtures (right), light and dark: the approval card, the reject box, the question card
// and a form card with validation. Writes compare.html with the remaining differences and their reasons.
// No backend, no model, no real data.
//
//   CREWFLOW_WEB_ORIGIN=http://localhost:5198 AI_U5_OUT=<dir> MOCKUP_DIR=<docs/design/ai> node packages/rab-docs/tools/web/capture-ai-u5.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAi } = require('./ai-twenty-parity-fixtures.cjs');

const OUT = process.env.AI_U5_OUT || path.resolve('u5-compare');
const MOCKUPS = process.env.MOCKUP_DIR || 'C:/Rab-recruit/docs/design/ai';
const THEMES = ['light', 'dark'];
const VIEWPORT = { width: 1440, height: 900 };
fs.mkdirSync(OUT, { recursive: true });

const fileUrl = (name) => 'file:///' + path.join(MOCKUPS, name).replace(/\\/g, '/');
const LIMITS = { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 };

/** Mockup state drivers (the owner's own buttons; nothing in the mockups is modified). */
async function mockup(browser, theme, file, steps, out) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(fileUrl(file));
  await page.waitForTimeout(400);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  for (const s of steps) {
    if (s.click) await page.click(s.click);
    if (s.scroll) await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), s.scroll);
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(OUT, out) });
  await ctx.close();
}

/** Crewflow state drivers (real app + fixtures). */
async function crewflow(browser, theme, state, go, out) {
  const { context, page, errors } = await openPage(browser, { persona: 'ceo', theme, viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  await installAi(page, state);
  if (state.availability) {
    // Unavailable-state fixtures: the exact server shapes for an ELIGIBLE caller (registered last = wins).
    await page.route('**/rest/v1/ai/availability', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-credentials': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ limits: LIMITS, usage: null, levels: null, assistant: null, ...state.availability }) }));
  }
  await go(page);
  await page.screenshot({ path: path.join(OUT, out) });
  await context.close();
  return errors;
}

const chat = async (page) => { await page.goto(`${APP_ORIGIN}/chat`, { timeout: 60000 }); await settle(page, 800); };
const models = async (page) => { await page.goto(`${APP_ORIGIN}/settings/ai?tab=models`, { timeout: 60000 }); await settle(page, 900); };
const scrollTo = (sel) => async (page) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); await settle(page, 300); };

const TITLE = 'Which shifts this weekend are unfilled?';
const openConv = async (page) => { await chat(page); await page.getByRole('button', { name: TITLE }).first().click(); await settle(page, 900); };

const PAIRS = [
  { key: 'approval', title: 'Chat · 4 Approval', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="approve"]' }] }, cf: { state: { conversation: 'u5approval', cards: 'approval' }, go: openConv },
    diffs: [
      ['Diff', 'Old values are struck through ONLY when the server sends previousValue (S6); without it the card shows the proposed values with no diff.'],
      ['Editable fields', 'Only the fields the server marked editable are inputs (here Start and Places); Role is shown as text. Only CHANGED fields are sent as edits; the server re-parses them strictly and re-checks everything.'],
      ['Write tools', 'Mockup: "Update shift" on a published shift. Crewflow’s write tools are draft shifts and staff notes only (create_draft_shift, update_draft_shift, add_staff_note); nothing published or sent to staff changes from a card.'],
      ['Shortcut', '⌘↵ on macOS, Ctrl+↵ elsewhere (shown on the button).'],
      ['Expiry', 'Crewflow shows "Expires in N min" from the server clock (expiresAt − serverNow); an expired card is read-only.'],
      ['Target', 'The shift is a record chip with its label read from the shift’s own route.'],
    ] },
  { key: 'reject', title: 'Chat · 4 Approval · reject with a reason', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="approve"]' }, { click: '#rejBtn' }] }, cf: { state: { conversation: 'u5approval', cards: 'approval' }, go: async (page) => { await openConv(page); const card = page.getByRole('region', { name: 'Update a draft shift' }); await card.getByRole('button', { name: 'Reject' }).click(); await card.getByLabel('Tell Crewflow why').fill('Keep 18:00, only add the extra place.'); await settle(page, 300); } },
    diffs: [
      ['Reason', 'A reason of 3–500 characters is required before Reject is enabled (server rule); it is the only thing sent.'],
      ['Placement', 'The reason box replaces the card’s buttons inside the same card (mockup: a second card below).'],
    ] },
  { key: 'question', title: 'Chat · 5 Question', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="ask"]' }] }, cf: { state: { conversation: 'u5question', cards: 'question' }, go: openConv },
    diffs: [
      ['Free text', 'Bounded to the question limit of the chat input (4,000 characters); sent as the person’s own input (masking and the outgoing-payload scan apply).'],
      ['State', 'The answer shows "Waiting for your answer below." while the turn is paused (waiting_for_input); answered, replaced and expired cards are read-only.'],
    ] },
  { key: 'form', title: 'Chat · 5 Question · a form (validation)', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="ask"]' }] }, cf: { state: { conversation: 'u5question', cards: 'form' }, go: async (page) => { await openConv(page); await page.getByRole('region', { name: 'Shift details' }).getByRole('button', { name: 'Send answers' }).click(); await settle(page, 300); } },
    diffs: [
      ['Mockup', 'The mockup has no form example; the card follows the question card. Every field is validated against what was asked (required, number, date, one of the options) and only the asked keys are sent.'],
    ] },
];

async function main() {
  const browser = await launch();
  const problems = [];
  try {
    for (const p of PAIRS) {
      for (const theme of THEMES) {
        await mockup(browser, theme, p.mock.file, p.mock.steps, `mock-${p.key}-${theme}.png`).catch((e) => problems.push(`mock ${p.key} ${theme}: ${String(e.message).split(String.fromCharCode(10))[0]}`));
        const errs = await crewflow(browser, theme, p.cf.state, p.cf.go, `cf-${p.key}-${theme}.png`).catch((e) => [`capture: ${String(e.message).split(String.fromCharCode(10))[0]}`]);
        problems.push(...errs.map((e) => `cf ${p.key} ${theme}: ${e}`));
      }
      process.stdout.write(`[u5] ${p.key}\n`);
    }
  } finally {
    await browser.close();
  }
  writeCompare();
  process.stdout.write(`[u5] problems: ${problems.length}\n${problems.join('\n')}\n`);
  if (problems.length) process.exitCode = 1;
}

function writeCompare() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sections = PAIRS.map((p) => `<section id="${p.key}"><h2>${esc(p.title)}</h2>
${THEMES.map((t) => `<div class="pair"><figure><img src="mock-${p.key}-${t}.png" alt="Mockup ${esc(p.title)} ${t}"><figcaption>Mockup · ${t}</figcaption></figure><figure><img src="cf-${p.key}-${t}.png" alt="Crewflow ${esc(p.title)} ${t}"><figcaption>Crewflow (fixtures) · ${t}</figcaption></figure></div>`).join('\n')}
<table><thead><tr><th>Remaining difference</th><th>Reason</th></tr></thead><tbody>${p.diffs.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></section>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>U5 comparison</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}section{border-top:1px solid var(--line);padding:16px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}figure{margin:0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
@media (max-width:760px){.pair{grid-template-columns:1fr}}</style></head><body>
<h1>U5 — mockup | implementation</h1><p>Left: the owner’s mockup (design reference). Right: Crewflow’s real UI with fictional fixtures. Each table lists what still differs and why. Crewflow uses its own tokens, components and icons; no mockup colour or script is used.</p>
${sections}</body></html>`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
