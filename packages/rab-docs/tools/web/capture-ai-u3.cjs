// U3 side-by-side (owner approval 2026-10-26, docs/ai/UI_U2_U8_PLAN.md): the owner's chat mockup (left) and Crewflow's
// REAL rab-front with fictional fixtures (right), light and dark: the empty state with the U3 chips, the skill-tag menu
// with two tagged skills, and "See what I can do". Writes compare.html with the remaining differences and their reasons.
// No backend, no model, no real data.
//
//   CREWFLOW_WEB_ORIGIN=http://localhost:5198 AI_U3_OUT=<dir> MOCKUP_DIR=<docs/design/ai> node packages/rab-docs/tools/web/capture-ai-u3.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAi } = require('./ai-twenty-parity-fixtures.cjs');

const OUT = process.env.AI_U3_OUT || path.resolve('u3-compare');
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

const openTagMenu = async (page) => {
  await chat(page);
  await page.getByRole('textbox', { name: 'Message Crewflow AI' }).focus();
  await page.keyboard.press('/');
  await settle(page, 300);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await settle(page, 300);
};

const PAIRS = [
  { key: 'empty', title: 'Chat · 1 Empty (U3: ＋, chips)', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }] }, cf: { state: {}, go: chat },
    diffs: [
      ['Draft a rota', 'Hidden: it is shown only when a write proposal can complete — the server lists the draft-shift tool for this person (GET /ai/capabilities) AND the chat can show and decide the approval card (U5). Before U5 a chip that cannot finish is not shown.'],
      ['See what I can do', 'Shown only once GET /ai/capabilities answers for this person (S4).'],
      ['＋', 'Tags a skill (also "/" in an empty composer). No attach: Crewflow sends text only.'],
      ['Colours / type', 'Crewflow tokens (index.css) and Tabler icons, not the mockup palette or glyphs.'],
    ] },
  { key: 'tags', title: 'Composer · tag a skill (menu open, two tagged)', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }] }, cf: { state: {}, go: openTagMenu },
    diffs: [
      ['Mockup', 'The mockup has the ＋ button (“Add: tag a skill”) but no open menu; Crewflow’s menu follows the Settings → AI customise menu pattern.'],
      ['Limit', 'At most 2 skills per question (AI_SKILL_LIMITS.maxTaggedPerMessage); the others are disabled once two are tagged. The server re-checks every name at submit (400 AI_SKILL_NOT_AVAILABLE → the list is re-read, nothing is re-sent).'],
      ['What a tag does', 'It asks the assistant to load that skill’s instructions. A skill gives no permission and no tool; only the names travel, never content.'],
    ] },
  { key: 'capabilities', title: 'See what I can do', mock: { file: 'crewflow-ai-chat-mockup.html', steps: [{ click: 'button[data-v="empty"]' }] }, cf: { state: {}, go: async (page) => { await chat(page); await page.getByRole('button', { name: 'See what I can do' }).click(); await settle(page, 300); } },
    diffs: [
      ['Mockup', 'The mockup has the chip but no sheet. Crewflow lists exactly GET /ai/capabilities: the read tools this person holds, write tools apart as “Changes I can suggest” (each waits on a card), and the active skills — plain text, nothing runs from here.'],
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
      process.stdout.write(`[u3] ${p.key}\n`);
    }
  } finally {
    await browser.close();
  }
  writeCompare();
  process.stdout.write(`[u3] problems: ${problems.length}\n${problems.join('\n')}\n`);
  if (problems.length) process.exitCode = 1;
}

function writeCompare() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sections = PAIRS.map((p) => `<section id="${p.key}"><h2>${esc(p.title)}</h2>
${THEMES.map((t) => `<div class="pair"><figure><img src="mock-${p.key}-${t}.png" alt="Mockup ${esc(p.title)} ${t}"><figcaption>Mockup · ${t}</figcaption></figure><figure><img src="cf-${p.key}-${t}.png" alt="Crewflow ${esc(p.title)} ${t}"><figcaption>Crewflow (fixtures) · ${t}</figcaption></figure></div>`).join('\n')}
<table><thead><tr><th>Remaining difference</th><th>Reason</th></tr></thead><tbody>${p.diffs.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></section>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>U3 comparison</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}section{border-top:1px solid var(--line);padding:16px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}figure{margin:0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
@media (max-width:760px){.pair{grid-template-columns:1fr}}</style></head><body>
<h1>U3 — mockup | implementation</h1><p>Left: the owner’s mockup (design reference). Right: Crewflow’s real UI with fictional fixtures. Each table lists what still differs and why. Crewflow uses its own tokens, components and icons; no mockup colour or script is used.</p>
${sections}</body></html>`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
