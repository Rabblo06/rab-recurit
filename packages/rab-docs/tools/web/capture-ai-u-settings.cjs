// U4 / U6 / U7 side-by-side (owner mockups 2026-10-26): the owner's mockup files (left) and Crewflow's REAL rab-front with
// fictional fixtures (right), light and dark, for every U4 (Settings → AI pages), U6 (Agents, storage only) and U7 (Usage,
// admin cost fields) state. Writes compare.html with the remaining differences and their reasons, plus the in-page checks
// (accessible names, unique ids, text contrast, no key-shaped text, no £). No backend, no model, no real data.
//
//   CREWFLOW_WEB_ORIGIN=http://localhost:5199 AI_U_SETTINGS_OUT=<dir> MOCKUP_DIR=<docs/design/ai> \
//     node packages/rab-docs/tools/web/capture-ai-u-settings.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAi } = require('./ai-twenty-parity-fixtures.cjs');
const { installUSettings, installAdminAi } = require('./ai-u-settings-fixtures.cjs');
const { installAdmin } = require('./admin-panel-fixtures.cjs');

const OUT = process.env.AI_U_SETTINGS_OUT || path.resolve('u-settings-compare');
const MOCKUPS = process.env.MOCKUP_DIR || 'C:/Rab-recruit/docs/design/ai';
const THEMES = ['light', 'dark'];
const VIEWPORT = { width: 1440, height: 900 };
fs.mkdirSync(OUT, { recursive: true });
const fileUrl = (name) => 'file:///' + path.join(MOCKUPS, name).replace(/\\/g, '/');
const SETTINGS = 'crewflow-ai-settings-mockup.html';
const AGENTS = 'crewflow-ai-agents-mockup.html';

async function mockup(browser, theme, file, steps, out) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(fileUrl(file));
  await page.waitForTimeout(400);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  for (const s of steps) {
    if (s.click) await page.click(s.click);
    if (s.scroll) await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 110); }, s.scroll);
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(OUT, out) });
  await ctx.close();
}

/** In-page checks on the AI surface (axe is not approved): names, ids, contrast, secrets, currency. */
async function inPageChecks(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.ai-settings-root') || document.querySelector('.ap-block') || document.body;
    const problems = [];
    const text = (el) => (el ? el.textContent || '' : '').replace(/\s+/g, ' ').trim();
    const nameOf = (el) => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
      if ((el.getAttribute('aria-label') || '').trim()) return el.getAttribute('aria-label').trim();
      if (el.id) { const l = Array.from(document.querySelectorAll('label')).find((x) => x.htmlFor === el.id); if (l && text(l)) return text(l); }
      const w = el.closest('label'); if (w && text(w)) return text(w);
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab') return text(el);
      return (el.getAttribute('title') || '').trim();
    };
    root.querySelectorAll('button, a[href], [role="switch"], [role="meter"], [role="tab"], input:not([type="hidden"]), select, textarea').forEach((el) => {
      if (!nameOf(el)) problems.push(`unnamed <${el.tagName.toLowerCase()}>`);
    });
    const ids = {};
    root.querySelectorAll('[id]').forEach((el) => { ids[el.id] = (ids[el.id] || 0) + 1; });
    Object.entries(ids).filter(([, n]) => n > 1).forEach(([id]) => problems.push(`duplicate id ${id}`));
    // WCAG contrast for visible text (AA: 4.5:1, 3:1 at ≥ 18.66 px bold / 24 px).
    const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    let worst = null;
    root.querySelectorAll('*').forEach((el) => {
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"]') || el.closest('[disabled], [aria-disabled="true"]')) return;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const fg = rgb(cs.color); if (!fg) return;
      const l1 = lum(fg), l2 = lum(bgOf(el));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
      const min = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < min && (!worst || ratio < worst.ratio)) worst = { ratio, text: text(el).slice(0, 40) };
      if (ratio < min) problems.push(`contrast ${ratio.toFixed(2)}:1 "${text(el).slice(0, 40)}"`);
    });
    const body = document.body.innerText;
    if (/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|ANTHROPIC_API_KEY=|OPENAI_API_KEY=/.test(body)) problems.push('key-shaped text on screen');
    if (/£/.test(root.innerText || '')) problems.push('£ shown on an AI cost surface');
    return problems;
  });
}

async function crewflow(browser, theme, cf, out) {
  const persona = cf.persona || 'ceo';
  const { context, page, errors } = await openPage(browser, { persona, theme, viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  if (persona === 'platformAdmin') {
    await page.addInitScript(() => { try { localStorage.setItem('cf-admin-tab', 'health'); } catch { /* blocked */ } });
    await installAdmin(page, { origin: APP_ORIGIN });
    await installAdminAi(page, APP_ORIGIN);
  } else {
    await installAi(page, {});
    await installUSettings(page, APP_ORIGIN, cf.variant || {});
  }
  await page.goto(`${APP_ORIGIN}${cf.path}`, { timeout: 60000 });
  await settle(page, 900);
  if (cf.then) await cf.then(page);
  await page.screenshot({ path: path.join(OUT, out) });
  const checks = await inPageChecks(page);
  await context.close();
  return { errors, checks };
}

/** Scrolls only the page's own scroll container (never the window), so the app shell stays put. */
const scrollTo = (sel) => async (page) => { await page.locator(sel).first().evaluate((el) => { const t = el.closest('.settings-section') || el; let p = t.parentElement; while (p && !(/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight)) p = p.parentElement; if (p) p.scrollTop += t.getBoundingClientRect().top - p.getBoundingClientRect().top - 8; }); await page.waitForTimeout(300); };
const click = (role, name) => async (page) => { await page.getByRole(role, { name }).first().click(); await page.waitForTimeout(400); };
const TAB = (t) => ({ click: `.tabs button[data-t="${t}"]` });
const COMMON = ['Colours / type / icons', 'Crewflow tokens (index.css), Tabler icons and Settings cards (`.settings-section`) instead of the mockup palette, emoji and bare headings. The app shell (sidebar, header) is Crewflow’s own.'];

const PAIRS = [
  // ── U4 ──
  { step: 'U4', key: 'overview', title: 'Overview', mock: { file: SETTINGS, steps: [TAB('overview')] }, cf: { path: '/settings/ai' },
    diffs: [
      ['Tab bar', 'Overview · Models · Skills · Tools · Usage, as in the mockup; "Agents" is added last only when the server’s features.agents is on (fixtures switch it on; the real server has it off). The prompt is a page under Overview, not a tab.'],
      ['Assistant', 'Crewflow’s presets (Crewflow, Amber, Sky, …) from the server, round only (owner rule); the mockup’s names (Ada, Scout, …) and shapes are design references. The existing face styles are kept.'],
      ['At a glance', 'Four real counts (your conversations, questions this month, skills on, tools you can use) from `counts`; the mockup shows three. Same one-row layout with the value on the right.'],
      COMMON,
    ] },
  { step: 'U4', key: 'overview-lower', title: 'Overview · MCP, organisation instructions, system prompt row', mock: { file: SETTINGS, steps: [TAB('overview'), { scroll: '#wsi' }] }, cf: { path: '/settings/ai', then: scrollTo('#ai-mcp-title') },
    diffs: [
      ['MCP server', 'Static "Coming later" row with no control (owner-approved plan A.2). The mockup’s "Claude or Cursor" wording is not used: no product names on a row that does nothing.'],
      ['Instructions counter', '"n / 2,000 · changes are audited" as in the mockup; Save and Remove ask a reason and a step-up (AiReasonDialog).'],
      ['Token figure', 'The prompt row shows "about N tokens" only after the prompt page was opened (opening it is audited, so Overview never fetches it); the mockup’s "~6.1k" is a sample.'],
    ] },
  { step: 'U4', key: 'prompt', title: 'Overview › System prompt', mock: { file: SETTINGS, steps: [{ click: '[data-x="prompt"]' }] }, cf: { path: '/settings/ai?tab=overview&page=prompt' },
    diffs: [
      ['Breadcrumb', '"Overview › System prompt" as in the mockup; the Overview tab stays selected; focus moves to the page heading.'],
      ['Section text', 'The REAL server sections (rules, answer format, organisation instructions, skills, tools, context) with their own token estimates; read-only plain text (never Markdown).'],
      ['Header', 'Crewflow adds a header with the prompt version, prompt caching state and Copy.'],
      ['User context', 'The mockup shows "User: Demo / Role: CEO"; the real context section has the organisation date and time zone only (no user name in the prompt).'],
    ] },
  { step: 'U4', key: 'prompt-skills', title: 'System prompt · skill catalogue (S9)', mock: { file: SETTINGS, steps: [{ click: '[data-x="prompt"]' }, { scroll: '#skcat' }] }, cf: { path: '/settings/ai?tab=overview&page=prompt', then: scrollTo('[data-section="skills"]') },
    diffs: [
      ['Source', 'From `skillCatalogue` (S9 fills it from the live prompt builder). While the server sends none: "No skill is switched on…" when no skill is on, otherwise "Not available yet". Never a made-up list.'],
    ] },
  { step: 'U4', key: 'prompt-skills-missing', title: 'System prompt · skill catalogue before S9', mock: { file: SETTINGS, steps: [{ click: '[data-x="prompt"]' }, { scroll: '#skcat' }] }, cf: { path: '/settings/ai?tab=overview&page=prompt', variant: { promptSkills: false }, then: scrollTo('#ai-prompt-skills') },
    diffs: [['State', 'Not in the mockup: the honest "Not available yet" state shown until S9 lands on the server.']] },
  { step: 'U4', key: 'models', title: 'Models (U1, unchanged)', mock: { file: SETTINGS, steps: [TAB('models')] }, cf: { path: '/settings/ai?tab=models' },
    diffs: [['Scope', 'Built and compared in U1 (Agent 8); unchanged here. Speed and Intelligence "—" ("No verified source yet"), no "Answer 100 questions" column, cost index from catalogue prices only.']] },
  { step: 'U4', key: 'skills', title: 'Skills', mock: { file: SETTINGS, steps: [TAB('skills')] }, cf: { path: '/settings/ai?tab=skills' },
    diffs: [
      ['Rows', 'The contract’s built-ins (rota-building, shift-filling, timesheet-review, coverage-report, venue-onboarding, crewflow-help) + the organisation’s custom skills. "Holiday planning" is not a built-in (no leave data; XD-4).'],
      ['App column', '"S Standard" / "C Custom" as in the mockup, Crewflow colours (info / brand tokens); the word carries the meaning.'],
      ['Illustration', 'Decorative, fixed copy and static (no scroll animation); hidden from assistive technology.'],
      COMMON,
    ] },
  { step: 'U4', key: 'skill-standard', title: 'Skill page · standard skill', mock: { file: SETTINGS, steps: [{ click: '[data-x="skill"]' }] }, cf: { path: '/settings/ai?tab=skills&skill=shift-filling' },
    diffs: [
      ['Instructions', 'The mockup shows the built-in text; the server does not send a standard skill’s text (`content: null`), so the block says "Not available yet" instead of inventing it.'],
      ['Danger zone', '"Turn off" (reason + step-up) and Delete disabled with the visible reason "Standard skills can’t be deleted."'],
      ['Counter', 'Description "n / 300" from the server limit.'],
    ] },
  { step: 'U4', key: 'skill-custom', title: 'Skill page · custom skill (editable)', mock: { file: SETTINGS, steps: [{ click: '[data-x="skill"]' }] }, cf: { path: '/settings/ai?tab=skills&skill=riverside-bar-rules' },
    diffs: [
      ['Editable', 'A custom skill: name, Markdown instructions ("n / 20,000"), description ("n / 300"), Preview (SafeMarkdown), Save → reason + step-up + audit. The mockup only shows the standard (disabled) form.'],
      ['Delete', 'Enabled for a custom skill, red text, through the reason dialog.'],
    ] },
  { step: 'U4', key: 'tools', title: 'Tools', mock: { file: SETTINGS, steps: [TAB('tools')] }, cf: { path: '/settings/ai?tab=tools' },
    diffs: [
      ['Create tool', 'Absent (tools are reviewed code; the mockup shows it disabled).'],
      ['Rows', 'The server catalogue (Phase 3 names); the mockup’s send_offer_reminder / ask_question are not tools on this server.'],
      ['Permission', 'The server’s permission label plus whether YOU hold it ("You have it" / "You don’t have this"), instead of a raw flag.'],
    ] },
  { step: 'U4', key: 'tool', title: 'Tool page', mock: { file: SETTINGS, steps: [{ click: '[data-x="tool"]' }] }, cf: { path: '/settings/ai?tab=tools&tool=list_unfilled_shifts' },
    diffs: [
      ['Parameters', 'From CD-9 `parameters` (shown "Not available yet" when absent); notes = server description + limits.'],
      ['Access', 'Kind, needs permission (+ yours), rows per answer. "Output fields" is not in the contract → "Not available yet" (server field needed).'],
      ['Danger zone', 'Delete disabled with the visible reason "Built-in tools can’t be deleted." (owner rule).'],
    ] },
  // ── U6 ──
  { step: 'U6', key: 'agents-list', title: 'Agents · list', mock: { file: AGENTS, steps: [{ click: 'button[data-v="list"]' }] }, cf: { path: '/settings/ai?tab=agents' },
    diffs: [
      ['Where', 'A tab of Settings → AI shown only when the server’s features.agents is on (AI_AGENTS_ENABLED; off on the real server — fixtures switch it on).'],
      ['Last run', '"—" with the EX-3 reason: agents can’t run (EX-3 deferred), so there is no run data. The mockup’s "Completed 3 days ago" can’t exist.'],
      ['Role', '"Agent role" / "No role (no data access)": the list has the role id only; the flag names are on the Role tab.'],
      ['Avatar', 'The default round avatar in the sleepy state (not running); agents have no stored look in the contract.'],
      ['Notice', 'An EX-3 notice under the heading.'],
    ] },
  { step: 'U6', key: 'agent-settings', title: 'Agent page · Settings', mock: { file: AGENTS, steps: [{ click: 'button[data-v="detail"]' }] }, cf: { path: '/settings/ai?tab=agents&agent=ag-1' },
    diffs: [
      ['Run switch', 'Off and disabled, described by the EX-3 reason (the mockup’s switch is on).'],
      ['Tabs', 'Settings · Role · Triggers, plus Runs and Test disabled with the EX-3 reason.'],
      ['Model', 'The contract’s two agent tiers (Fast / Smart) with the level glyph.'],
      ['Response format', '"JSON with fields" is not in the contract (`responseFormat: text`) → "Not available yet".'],
      ['Save', 'Sends only the changed fields + reason (step-up + audit); Ctrl/⌘ + Enter opens the same dialog.'],
    ] },
  { step: 'U6', key: 'agent-role', title: 'Agent page · Role', mock: { file: AGENTS, steps: [{ click: 'button[data-v="detail"]' }, { click: '#dtabs button[data-t="role"]' }] }, cf: { path: '/settings/ai?tab=agents&agent=ag-1', then: click('tab', 'Role') },
    diffs: [
      ['Flags', 'Every flag of the C1 agent allowlist from GET /ai/agents/:id/role, with Allowed / Not allowed; only the server’s `grantable` flags can be ticked (6a: the three view flags you hold); the rest say "you can’t grant this yet". Save → PUT {flags, reason}.'],
      ['Blocked row', '"Right-to-work, contact details and pay changes — never available to agents" (fixed product rule).'],
    ] },
  { step: 'U6', key: 'agent-triggers', title: 'Agent page · Triggers', mock: { file: AGENTS, steps: [{ click: 'button[data-v="detail"]' }, { click: '#dtabs button[data-t="triggers"]' }] }, cf: { path: '/settings/ai?tab=agents&agent=ag-1', then: click('tab', 'Triggers') },
    diffs: [
      ['Turn on', 'Disabled with the EX-3 reason (the server refuses enable with 409 anyway); the mockup shows a live switch.'],
      ['Add trigger', 'Stores a trigger switched off (schedule DSL or record events), reason + step-up; delete per trigger.'],
      ['Limits', 'Real AI_AGENT_LIMITS numbers (100 runs per hour, 20 events per run, 5 triggers).'],
    ] },
  { step: 'U6', key: 'agent-trigger-add', title: 'Agent page · Add trigger form', mock: { file: AGENTS, steps: [{ click: 'button[data-v="detail"]' }, { click: '#dtabs button[data-t="triggers"]' }] }, cf: { path: '/settings/ai?tab=agents&agent=ag-1', then: async (page) => { await click('tab', 'Triggers')(page); await click('button', 'Add trigger')(page); } },
    diffs: [['State', 'Not in the mockup (it only shows "＋ Add trigger"). Esc or Cancel closes it and returns focus to "Add trigger".']] },
  { step: 'U6', key: 'agent-runs', title: 'Agent page · Runs', mock: { file: AGENTS, steps: [{ click: 'button[data-v="detail"]' }, { click: '#dtabs button[data-t="runs"]' }] }, cf: { path: '/settings/ai?tab=agents&agent=ag-2' },
    diffs: [['Runs', 'Disabled with the EX-3 reason: there is no runs route and nothing runs. The mockup’s run rows (Completed / Waiting / Failed, costs) can’t exist before EX-3. Shown here: a second agent with no role.']] },
  { step: 'U6', key: 'agent-standard', title: 'Agent page · standard agent (read-only)', mock: { file: AGENTS, steps: [{ click: 'button[data-v="list"]' }] }, cf: { path: '/settings/ai?tab=agents&agent=ag-3' },
    diffs: [['Read-only', 'Not in the mockup as a page: a standard agent’s fields are disabled, there is no Save, and Delete is disabled with "Standard agents can’t be deleted."']] },
  // ── U7 ──
  { step: 'U7', key: 'usage', title: 'Usage · stat box and last 14 days', mock: { file: SETTINGS, steps: [TAB('usage')] }, cf: { path: '/settings/ai?tab=usage' },
    diffs: [
      ['Numbers', 'Real ledger numbers from GET /ai/settings/usage (fixtures here): Today = live meter / organisation daily budget, This month = ledger total, Messages today = today’s turns. USD by integer division.'],
      ['Chart', 'One series (--chart-1) against a dashed budget line (Crewflow ink, not red). Hover or ←/→ reads a day; "Show as table" gives the numbers. UTC days.'],
      ['Tokens line', 'Crewflow adds today’s token meter and the month’s cached-input share under the stat box.'],
    ] },
  { step: 'U7', key: 'usage-tooltip', title: 'Usage · reading one day (keyboard)', mock: { file: SETTINGS, steps: [TAB('usage')] }, cf: { path: '/settings/ai?tab=usage', then: async (page) => { await page.locator('.ai-usage-chart').focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(200); } },
    diffs: [['Tooltip', 'Not in the mockup (it has a title attribute per bar). Focus the chart, ←/→/Home/End; Esc closes.']] },
  { step: 'U7', key: 'usage-no-daily', title: 'Usage · before S8 (no daily series)', mock: { file: SETTINGS, steps: [TAB('usage')] }, cf: { path: '/settings/ai?tab=usage', variant: { daily: false } },
    diffs: [['Chart', '"Not available yet" until the server sends `daily` (S8). No made-up series.']] },
  { step: 'U7', key: 'usage-tables', title: 'Usage · by person and by model', mock: { file: SETTINGS, steps: [TAB('usage'), { scroll: '#p-usage table' }] }, cf: { path: '/settings/ai?tab=usage', then: scrollTo('#ai-usage-people') },
    diffs: [
      ['Period', 'A This month / Today switch for the tables (the mockup shows the month only).'],
      ['Per-person USD', 'Shown to the CEO with the note "provisional owner decision (26 Oct 2026)".'],
      ['Budgets note', 'Plain words; no environment variable names on a CEO screen.'],
    ] },
  { step: 'U7', key: 'admin-usage', title: 'Admin panel · Health → AI usage by organisation (7b fields)', mock: null, cf: { path: '/settings/admin', persona: 'platformAdmin', then: scrollTo('.ap-block[aria-label="AI assistant health"] .ap-tablewrap') },
    diffs: [
      ['Mockup', 'No mockup for the admin panel AI section; follow-up 3 of the plan.'],
      ['Columns', 'Cached input, cache writes, estimated cost (USD), and today’s budget alerts as "Cost 80 %" / "Tokens 80 %" tags; an absent field is "—".'],
      ['Per-person limit', 'Shown when the overview sends `limits.userDailyBudgetUsd` (requested from Agent 9; "—" until then).'],
    ] },
];

async function main() {
  const browser = await launch();
  const problems = [];
  const checks = {};
  try {
    for (const p of PAIRS) {
      for (const theme of THEMES) {
        if (p.mock) await mockup(browser, theme, p.mock.file, p.mock.steps, `mock-${p.key}-${theme}.png`).catch((e) => problems.push(`mock ${p.key} ${theme}: ${String(e.message).split('\n')[0]}`));
        const r = await crewflow(browser, theme, p.cf, `cf-${p.key}-${theme}.png`).catch((e) => ({ errors: [`capture: ${String(e.message).split('\n')[0]}`], checks: [] }));
        problems.push(...r.errors.map((e) => `cf ${p.key} ${theme}: ${e}`));
        checks[`${p.key}-${theme}`] = r.checks;
      }
      process.stdout.write(`[u-settings] ${p.key}\n`);
    }
  } finally {
    await browser.close();
  }
  writeCompare(checks);
  fs.writeFileSync(path.join(OUT, 'in-page-checks.json'), JSON.stringify(checks, null, 2));
  const checkCount = Object.values(checks).reduce((n, c) => n + c.length, 0);
  process.stdout.write(`[u-settings] capture problems: ${problems.length}; in-page check findings: ${checkCount}\n${problems.join('\n')}\n`);
  if (problems.length) process.exitCode = 1;
}

function writeCompare(checks) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sections = PAIRS.map((p) => {
    const found = THEMES.flatMap((t) => (checks[`${p.key}-${t}`] || []).map((c) => `${t}: ${c}`));
    return `<section id="${p.key}"><h2><span class="step">${p.step}</span> ${esc(p.title)}</h2>
${THEMES.map((t) => `<div class="pair">${p.mock ? `<figure><img loading="lazy" src="mock-${p.key}-${t}.png" alt="Mockup ${esc(p.title)} ${t}"><figcaption>Mockup · ${t}</figcaption></figure>` : '<figure class="none"><div>No mockup for this state</div></figure>'}<figure><img loading="lazy" src="cf-${p.key}-${t}.png" alt="Crewflow ${esc(p.title)} ${t}"><figcaption>Crewflow (fixtures) · ${t}</figcaption></figure></div>`).join('\n')}
<table><thead><tr><th>Remaining difference</th><th>Reason</th></tr></thead><tbody>${p.diffs.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>
<p class="checks">In-page checks (names, unique ids, text contrast, no key-shaped text, no £): ${found.length ? `<b>${found.length} finding(s)</b><br>${found.map(esc).join('<br>')}` : '0 findings in light and dark'}.</p></section>`;
  }).join('\n');
  const toc = ['U4', 'U6', 'U7'].map((s) => `<li><b>${s}</b>: ${PAIRS.filter((p) => p.step === s).map((p) => `<a href="#${p.key}">${esc(p.title)}</a>`).join(' · ')}</li>`).join('');
  fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>U4 U6 U7 comparison</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb;--chip:#f0f1f3}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d;--chip:#24252b}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}section{border-top:1px solid var(--line);padding:16px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}figure{margin:0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--muted);font-size:12px}
figure.none div{display:grid;place-items:center;aspect-ratio:16/10;border:1px dashed var(--line);border-radius:6px;color:var(--muted)}
.step{display:inline-block;padding:0 6px;border-radius:4px;background:var(--chip);font-size:12px;vertical-align:middle}.checks{color:var(--muted);font-size:12.5px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}a{color:inherit}
@media (max-width:760px){.pair{grid-template-columns:1fr}}</style></head><body>
<h1>U4 · U6 · U7 — mockup | implementation</h1><p>Left: the owner’s mockups (design reference). Right: Crewflow’s real UI with fictional fixtures (no backend, no model, no real data). Each section lists what still differs and why, and the in-page checks for both themes. Crewflow uses its own tokens, components and icons; no mockup colour or script is used.</p>
<ul>${toc}</ul>
${sections}</body></html>`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
