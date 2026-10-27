// U2 side-by-side (owner approval 2026-10-26, docs/ai/UI_U2_U8_PLAN.md B): the owner's chat mockup (left) and Crewflow's
// REAL rab-front with fictional fixtures (right), light and dark: "2 Answer" (steps, table, record chips, footer), a step
// expanded, the context/usage popover (More), and the "3 Ask AI panel" with a running answer and one queued question.
// Writes compare.html with the remaining differences and their reasons. No backend, no model, no real data.
//
//   CREWFLOW_WEB_ORIGIN=http://localhost:5198 AI_U2_OUT=<dir> MOCKUP_DIR=<docs/design/ai> node packages/rab-docs/tools/web/capture-ai-u2.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAi, captureStreamShim, STREAM_PLAN } = require('./ai-twenty-parity-fixtures.cjs');

const OUT = process.env.AI_U2_OUT || path.resolve('u2-compare');
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
  if (state.frames) await captureStreamShim(page, STREAM_PLAN);
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
const openAnswer = async (page) => { await chat(page); await page.getByRole('button', { name: TITLE }).first().click(); await settle(page, 900); await page.locator('.ai-message.assistant').last().hover(); };
const openPanel = async (page) => {
  await page.goto(`${APP_ORIGIN}/`, { timeout: 60000 });
  await settle(page, 900);
  await page.keyboard.press('Control+j');
  const panel = page.getByRole('complementary', { name: 'Ask AI' });
  await panel.getByRole('button', { name: 'Show history' }).click();
  await panel.getByRole('button', { name: TITLE }).first().click();
  await settle(page, 900);
};

const PAIRS = [
  { key: 'answer', title: 'Chat · 2 Answer', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="convo"]' }] }, cf: { state: { conversation: 'u2answer' }, go: openAnswer },
    diffs: [
      ['Record chips', 'Mockup chips carry the model’s own text. Crewflow renders a chip only for a server-validated [[record:…]] reference in the STORED answer and reads the label from the record’s own route (shift → "Sat 31 Oct · 18:00", venue → its name); a record the person cannot see shows "Record unavailable". While streaming, references stay plain text. Staff references are an unlinked "Staff member" chip (no web read route).'],
      ['Steps', 'Same order (thought, skill, tools). Labels are the fixed server labels; "Learned “Shift filling”" reads the skill LABEL from GET /ai/skills. No "· 182 ms" (owner decision 8).'],
      ['Footer', 'Mockup: ⧉ 👍 👎 "Fast · Haiku 5.5 · $0.0011". Crewflow: copy + level · model · cost from the turn’s own ledger row (S1); no 👍/👎 (owner decision 7). The model label comes from the models list, never free text.'],
      ['@mention', 'Mockup user message starts "@Ada". Crewflow has no @mention (not in U2 scope).'],
      ['JSON draft block', 'Mockup shows a "Suggested draft (not saved yet)" JSON block; drafts arrive as approval cards (U5), not as code in the answer.'],
      ['Table', 'Crewflow adds GFM tables (the mockup prompt asks for them): plain-text cells in a scroll container, at most 200 rows × 20 columns.'],
      ['Colours / type', 'Crewflow tokens (index.css) and Tabler icons, not the mockup palette or glyphs.'],
    ] },
  { key: 'step', title: 'Chat · 2 Answer · a step expanded', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="convo"]' }, { click: '.step[data-t="b3"]' }] }, cf: { state: { conversation: 'u2answer' }, go: async (page) => { await openAnswer(page); await page.getByRole('button', { name: /unfilled shifts/i }).first().click(); await settle(page, 300); } },
    diffs: [
      ['Expanded content', 'Mockup shows the tool’s input JSON and output. Crewflow shows server facts only: Result, Records (row count), Skills (labels) and the fixed line "Inputs and outputs aren’t shown. Names, contact details and pay are removed before the assistant sees any record." (owner decision 2, rule 11.2).'],
      ['Thought for', 'Mockup expands "Thought for 2s" into reasoning text. Crewflow: not expandable — the reasoning text is discarded in the Worker; only the duration exists.'],
    ] },
  { key: 'usage', title: 'Composer · context and usage (More)', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }, { click: '#ctxBtn' }, { click: '#ctxToggle' }] }, cf: { state: { conversation: 'u2answer' }, go: async (page) => { await openAnswer(page); await page.getByRole('button', { name: 'Context and usage' }).click(); await page.locator('.ai-popover-body').getByRole('button', { name: 'More' }).click(); await settle(page, 300); } },
    diffs: [
      ['Context', 'Mockup: "(24k/200k) 12%" of the model window. Crewflow: "Context used" against the Phase 7 per-step context budget from the turn’s ledger row (S1), never the provider window.'],
      ['Currency', 'Mockup icon "£" next to a $ figure. Crewflow: US dollars only, four decimals for a message or conversation.'],
      ['Allowance', 'Crewflow shows which allowance is tighter (yours or the organisation’s) and when it resets (00:00 UTC), from GET /ai/availability.'],
      ['Missing figures', 'A turn without a ledger row shows "—" (title "Not recorded"); nothing is estimated.'],
    ] },
  { key: 'panel', title: 'Ask AI panel · thinking (one queued question)', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="panel"]' }] }, cf: { state: { conversation: 'u2queued', frames: true }, go: openPanel },
    diffs: [
      ['Composer while thinking', 'Mockup disables the composer. Crewflow allows ONE more question, shown with "Queued · asks after the current answer" and Remove; after that only Stop is offered (owner decision 6).'],
      ['Opening', 'Opened with Ctrl+J here (⌘J on macOS; owner decision 5); the header keeps history ↺, new chat, expand ⤢ and close ✕.'],
      ['Plan', 'Crewflow shows the update_plan checklist from the stream; "Plan approved" waits for the approval cards (U5).'],
      ['Page behind', 'The real Dashboard stays visible behind the panel (mockup: a fake Shifts list).'],
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
      process.stdout.write(`[u2] ${p.key}\n`);
    }
  } finally {
    await browser.close();
  }
  writeCompare();
  process.stdout.write(`[u2] problems: ${problems.length}\n${problems.join('\n')}\n`);
  if (problems.length) process.exitCode = 1;
}

function writeCompare() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sections = PAIRS.map((p) => `<section id="${p.key}"><h2>${esc(p.title)}</h2>
${THEMES.map((t) => `<div class="pair"><figure><img src="mock-${p.key}-${t}.png" alt="Mockup ${esc(p.title)} ${t}"><figcaption>Mockup · ${t}</figcaption></figure><figure><img src="cf-${p.key}-${t}.png" alt="Crewflow ${esc(p.title)} ${t}"><figcaption>Crewflow (fixtures) · ${t}</figcaption></figure></div>`).join('\n')}
<table><thead><tr><th>Remaining difference</th><th>Reason</th></tr></thead><tbody>${p.diffs.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></section>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>U2 comparison</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}section{border-top:1px solid var(--line);padding:16px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}figure{margin:0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
@media (max-width:760px){.pair{grid-template-columns:1fr}}</style></head><body>
<h1>U2 — mockup | implementation</h1><p>Left: the owner’s mockup (design reference). Right: Crewflow’s real UI with fictional fixtures. Each table lists what still differs and why. Crewflow uses its own tokens, components and icons; no mockup colour or script is used.</p>
${sections}</body></html>`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
