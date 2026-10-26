// U1 side-by-side (owner mockups 2026-10-26): the owner's mockup files (left) and Crewflow's REAL rab-front with fictional
// fixtures (right), light and dark, for every U1 state: chat "1 Empty", the four "6 Unavailable" banners, the tier picker
// open + model card + model details, and Settings → AI → Models (top box, tree with "Choose automatically" off, preview,
// catalogue). Writes compare.html with the remaining differences and their reasons. No backend, no model, no real data.
//
//   CREWFLOW_WEB_ORIGIN=http://localhost:5198 AI_U1_OUT=<dir> MOCKUP_DIR=<docs/design/ai> node packages/rab-docs/tools/web/capture-ai-u1.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAi } = require('./ai-twenty-parity-fixtures.cjs');

const OUT = process.env.AI_U1_OUT || path.resolve('u1-compare');
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

const PAIRS = [
  { key: 'empty', title: 'Chat · 1 Empty', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }] }, cf: { state: {}, go: chat },
    diffs: [
      ['Chips', 'Mockup: Find open shifts · Draft a rota · See what I can do. Crewflow: Find open shifts · See what I can do. "Draft a rota" needs the approval cards (8c, waits for the owner’s D8-1 design); a chip that cannot complete is not shown.'],
      ['Composer hint', 'Mockup: "Ask, search or make anything…". Crewflow keeps "Ask about shifts, fill rate, offers, attendance or payroll totals…" (H6: no open-web search exists, so the hint does not promise one).'],
      ['＋ button', 'Not shown: no attach and no skill tags yet (H7 conflict; tags arrive with Phase 4).'],
      ['Counter / footer', 'Crewflow shows the always-visible n / 4,000 counter (C8-6) and the D8-2 footer line instead of the mockup’s shorter note.'],
      ['Header meter', 'Crewflow keeps "Organisation AI use today" (L2) above the chat.'],
      ['Colours / type', 'Crewflow tokens (index.css) and Tabler icons, not the mockup palette or glyphs.'],
    ] },
  { key: 'unavail-provider', title: '6 Unavailable · provider not set up', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="off"]' }] }, cf: { state: { availability: { available: false, reason: 'not_configured', setup: 'provider', message: "AI isn't set up yet. A platform admin needs to add a provider key" } }, go: chat },
    diffs: [['Layout', 'The mockup shows all four banners at once as a catalogue; Crewflow shows the one banner that applies (the server’s reason picks it). The (503 …) annotations are the mockup’s notes, not UI text.']] },
  { key: 'unavail-model', title: '6 Unavailable · choose a model', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="off"]' }] }, cf: { state: { availability: { available: false, reason: 'not_configured', setup: 'model', message: 'Choose a model in Settings → AI' } }, go: chat },
    diffs: [['Link', '"Open AI settings" is shown to the CEO only (the fixture persona is the CEO); Settings → AI is a 404 for anyone else.']] },
  { key: 'unavail-demo', title: '6 Unavailable · demo data only', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="off"]' }] }, cf: { state: { availability: { available: false, reason: 'demo_data_only', message: 'AI is available for demo data only until the provider checklist is complete.' } }, go: chat },
    diffs: [['Icon', 'Tabler flask icon instead of the mockup emoji.']] },
  { key: 'unavail-failed', title: '6 Unavailable · turn failed', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="off"]' }] }, cf: { state: { conversation: 'failed' }, go: async (page) => { await chat(page); await page.getByRole('button', { name: 'Which shifts this weekend are unfilled?' }).first().click(); await settle(page, 800); } },
    diffs: [['Detail', 'Crewflow adds the fixed reason for the error code after "Nothing was changed." "Try again" puts the question back in the composer; nothing is re-sent automatically.']] },
  { key: 'tier', title: 'Tier picker open · model card', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }, { click: '#tierBtn' }] }, cf: { state: {}, go: async (page) => { await chat(page); await page.getByRole('button', { name: /^Level:/ }).click(); await settle(page, 400); } },
    diffs: [
      ['Intelligence / Speed', 'Mockup: −22% / +3.9×. Crewflow: "—" with the tooltip "No verified source yet" (owner rule 5: no invented numbers).'],
      ['Comparison base', 'Mockup: "Vs Balanced mode". Crewflow compares with the organisation’s chat level (Balanced has no approved model); the cost index is the server’s catalogue-price ratio.'],
      ['Read-only', 'Until the server accepts a level on submit (submitAcceptsLevel), the slider shows the organisation’s level and cannot move; the note says so.'],
      ['Fast', 'Shown unavailable ("Effort not verified · using Extra fast") because the catalogue has no verified medium effort for Haiku (owner rule 5).'],
    ] },
  { key: 'details', title: 'Model details', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }, { click: '#tierBtn' }, { click: '#mcInfo' }] }, cf: { state: {}, go: async (page) => { await chat(page); await page.getByRole('button', { name: /^Level:/ }).click(); await settle(page, 300); await page.getByRole('button', { name: 'Model details' }).click(); await settle(page, 300); } },
    diffs: [
      ['Benchmarks', 'Mockup: Intelligence 62, Speed 96 and "benchmarks: Artificial Analysis". Crewflow: "—" (no verified source); no benchmark attribution.'],
      ['Modalities', 'Crewflow states "Text only" / "Text": Crewflow sends and shows text only (images, audio and files are never sent).'],
      ['Costs', 'US dollars per 1M tokens from the catalogue (never £). Cached input added.'],
    ] },
  { key: 'models-top', title: 'Settings → AI → Models · top box', mock: { file: 'crewflow-ai-settings-mockup.html', steps: [{ click: '.tabs button[data-t="models"]' }] }, cf: { state: {}, go: models },
    diffs: [
      ['Agents row', 'Disabled with the EX-3 reason (agents cannot run until the owner approves EX-3).'],
      ['Residency', 'Any region + EU (the server’s values); UK listed disabled as "No approved UK-hosted model".'],
      ['Selects', 'Crewflow native selects (the design system’s form control) instead of the mockup’s custom menus; the bars glyph is shown in the tree and tables.'],
    ] },
  { key: 'models-tree', title: 'Models · "Choose automatically" off', mock: { file: 'crewflow-ai-settings-mockup.html', steps: [{ click: '.tabs button[data-t="models"]' }, { click: '#auto' }] }, cf: { state: {}, go: async (page) => { await models(page); await page.getByRole('switch', { name: 'Choose automatically' }).click(); await settle(page, 400); } },
    diffs: [['Fallback wording', 'Each level shows the server’s resolution or its reason ("No approved model", "Unavailable: effort not verified yet"); a fallback appears only when the server reports one.']] },
  { key: 'models-preview', title: 'Models · preview', mock: { file: 'crewflow-ai-settings-mockup.html', steps: [{ click: '.tabs button[data-t="models"]' }, { scroll: '#preview' }] }, cf: { state: {}, go: async (page) => { await models(page); await scrollTo('#ai-preview-title')(page); } },
    diffs: [['Columns', 'Mockup: ≈400 tok/s, 72, "Answer 100 questions". Crewflow: Speed and Intelligence "—" (no verified source) and a Cost index from catalogue prices; no 100-question estimate (owner rule 5).']] },
  { key: 'models-catalogue', title: 'Models · catalogue', mock: { file: 'crewflow-ai-settings-mockup.html', steps: [{ click: '.tabs button[data-t="models"]' }, { scroll: '#catalog' }] }, cf: { state: {}, go: async (page) => { await models(page); await scrollTo('#ai-catalogue-title')(page); } },
    diffs: [['Rows', 'The real catalogue (ai-models.json) and its states from the server; prices in US dollars.']] },
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
      process.stdout.write(`[u1] ${p.key}\n`);
    }
  } finally {
    await browser.close();
  }
  writeCompare();
  process.stdout.write(`[u1] problems: ${problems.length}\n${problems.join('\n')}\n`);
  if (problems.length) process.exitCode = 1;
}

function writeCompare() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sections = PAIRS.map((p) => `<section id="${p.key}"><h2>${esc(p.title)}</h2>
${THEMES.map((t) => `<div class="pair"><figure><img src="mock-${p.key}-${t}.png" alt="Mockup ${esc(p.title)} ${t}"><figcaption>Mockup · ${t}</figcaption></figure><figure><img src="cf-${p.key}-${t}.png" alt="Crewflow ${esc(p.title)} ${t}"><figcaption>Crewflow (fixtures) · ${t}</figcaption></figure></div>`).join('\n')}
<table><thead><tr><th>Remaining difference</th><th>Reason</th></tr></thead><tbody>${p.diffs.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></section>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>U1 comparison</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}section{border-top:1px solid var(--line);padding:16px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}figure{margin:0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
@media (max-width:760px){.pair{grid-template-columns:1fr}}</style></head><body>
<h1>U1 — mockup | implementation</h1><p>Left: the owner’s mockup (design reference). Right: Crewflow’s real UI with fictional fixtures. Each table lists what still differs and why. Crewflow uses its own tokens, components and icons; no mockup colour or script is used.</p>
${sections}</body></html>`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
