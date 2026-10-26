// Crewflow AI × Twenty parity captures (TWENTY_UI_CONTRACT_DELTAS §5 "Screenshot comparison"). One Crewflow capture per
// Twenty screenshot 01–33 at 1440 light, 1440 dark and 390 light, from the REAL rab-front (Vite dev server of this
// worktree) with FICTIONAL fixtures (fixtures.cjs + ai-twenty-parity-fixtures.cjs; no backend, no model). 28–33 come from
// the TEST-ONLY avatar gallery written by avatar.static.spec.tsx (AVATAR_GALLERY_OUT). Also writes compare.html (Twenty
// left, Crewflow right, the inventory rows under each pair) and a11y-report.json (in-page checks: accessible names,
// duplicate ids, text contrast, no horizontal scroll at 390 px, avatar motion off under reduced motion).
//
//   CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5198 AI_PARITY_OUT=<dir> AVATAR_GALLERY_DIR=<dir> \
//     node packages/rab-docs/tools/web/capture-ai-twenty-parity.cjs [NN ...]
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAi, captureStreamShim, STREAM_PLAN } = require('./ai-twenty-parity-fixtures.cjs');

const OUT = process.env.AI_PARITY_OUT || path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'ai', 'screenshots', 'twenty-parity');
const TWENTY_SRC = process.env.TWENTY_DIR || 'C:/Rab-recruit/docs/design/twenty-ai';
const GALLERY = process.env.AVATAR_GALLERY_DIR || '';
const ONLY = process.argv.slice(2);
const VARIANTS = [
  { key: '1440-light', viewport: { width: 1440, height: 900 }, theme: 'light' },
  { key: '1440-dark', viewport: { width: 1440, height: 900 }, theme: 'dark' },
  { key: '390-light', viewport: { width: 390, height: 844 }, theme: 'light' },
];
fs.mkdirSync(OUT, { recursive: true });

const settingsTab = (tab, extra = '') => async (page) => {
  await page.goto(`${APP_ORIGIN}/settings/ai?tab=${tab}${extra}`);
  await settle(page, 900);
};
const chat = (conversation, title) => async (page, v) => {
  await page.goto(`${APP_ORIGIN}/chat`);
  await settle(page, 700);
  if (conversation) {
    const link = page.getByRole('button', { name: title }).or(page.getByRole('link', { name: title })).first();
    if (v.viewport.width < 760) {
      const menu = page.getByRole('button', { name: 'Open navigation' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click();
        await settle(page, 400);
      }
    }
    await link.click({ timeout: 5000 }).catch(() => undefined);
    await settle(page, 900);
    // On a phone the navigation drawer may stay open over the chat: close it.
    if (v.viewport.width < 760 && (await page.locator('.sidebar-backdrop').count())) {
      await page.keyboard.press('Escape');
      await settle(page, 300);
    }
  }
};
const panel = (conversation, title) => async (page, v) => {
  await page.goto(`${APP_ORIGIN}/`);
  await settle(page, 700);
  if (v.viewport.width <= 1000) return chat(conversation, title)(page, v);
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await settle(page, 500);
  if (conversation) {
    await page.getByRole('button', { name: 'Show history' }).click();
    await settle(page, 400);
    await page.locator('.ai-panel-history').getByText(title).first().click();
    await settle(page, 900);
  }
};

const TITLE = 'Which shifts this weekend are unfilled?';
/** One entry per Twenty screenshot: how to reach the matching Crewflow state, and its inventory rows. */
const SHOTS = [
  { n: '01', slug: 'chat-level-popover', state: {}, go: async (p, v) => { await chat()(p, v); await p.getByRole('button', { name: /^Level:/ }).click(); await settle(p, 400); }, rows: 'H1–H3, H6, H9–H11 BUILD; G1–G3, G6 BUILD ADAPTED (slider over server levels, model from availability); G4, G5 CONFLICT (absent); H7, H8 CONFLICT (no attach, no mic); C14 catalogue labels only' },
  { n: '02', slug: 'chat-empty-baseline', state: { capabilities: false }, go: chat(), rows: 'L1–L6 Crewflow baseline; L5 counter always n / max (C8-6); L6 one footer line (D8-2)' },
  { n: '03', slug: 'settings-models', state: {}, go: settingsTab('models'), rows: 'A1–A2 tabs; C1, C2, C4, C6 BUILD ADAPTED; C3 SHOW AS DISABLED (EX-3, reason shown); C5 "US" CONFLICT (absent); C15, C16 Speed / Intelligence CONFLICT (absent); C17, C18 preview with real catalogue prices and the "up to" estimate' },
  { n: '04', slug: 'settings-models-levels', state: { pinned: true }, go: settingsTab('models'), rows: 'C6 off + C7–C12 level tree (Extra fast resolves to Haiku; Fast "effort not verified"; Balanced / Smart / Extra smart "No approved model"); C13 glyph; C14 CONFLICT (only catalogue models)' },
  { n: '05', slug: 'settings-overview', state: {}, go: settingsTab('overview'), rows: 'B1–B10 presets (Crewflow names, placeholders for owner review); B21–B24 counts only; B25 MCP CONFLICT (absent); B26–B27 organisation instructions; B28 prompt link' },
  { n: '06', slug: 'settings-overview-customise', state: { assistant: 'custom' }, go: async (p, v) => { await settingsTab('overview')(p, v); await p.getByRole('radio', { name: /Juniper/ }).click(); await settle(p, 500); }, rows: 'B11 custom card; B12 name (+ "AI" badge, never sent to the model); B13–B17 shape / colour / face / animate / reset' },
  { n: '07', slug: 'settings-overview-shape', state: { assistant: 'custom' }, go: async (p, v) => { await settingsTab('overview')(p, v); await p.getByRole('radio', { name: /Juniper/ }).click(); await settle(p, 400); await p.getByRole('menuitem', { name: /Shape/ }).click(); await settle(p, 400); }, rows: 'B18 shape submenu: 10 ORIGINAL parametric shapes, check on current' },
  { n: '08', slug: 'settings-skills', state: {}, go: settingsTab('skills'), rows: 'D1 decorative illustration (fixed copy); D2–D5, D10–D12, D19; D6–D9 code interpreter / Word / PowerPoint / Research CONFLICT (absent)' },
  { n: '09', slug: 'settings-tools', state: {}, go: settingsTab('tools'), rows: 'E1 illustration; E2–E4, E9 read-only table with the permission each tool needs and "You don’t have this"; E5–E8 WhatsApp / website / create-record CONFLICT (absent); E10 "Create tool" CONFLICT (absent)' },
  { n: '10', slug: 'settings-skill-detail', state: {}, go: settingsTab('skills', '&skill=house-style'), rows: 'D13 instructions (≤ 20,000, safe preview); D15 description; D16–D18 turn off / delete (reason + step-up); D14 code / record-write text CONFLICT (absent)' },
  { n: '11', slug: 'settings-tool-detail', state: {}, go: settingsTab('tools', '&tool=list_unfilled_shifts'), rows: 'E11–E14 parameters (CD-9 fixture); E16 description read-only; E17 "Who can use it" replaces delete; E15 "See function" CONFLICT (absent)' },
  { n: '12', slug: 'settings-prompt', state: {}, go: settingsTab('prompt'), rows: 'F1–F3 sections as plain text; F12 local token estimates' },
  { n: '13', slug: 'settings-prompt-format', state: {}, go: async (p, v) => { await settingsTab('prompt')(p, v); await p.locator('#ai-prompt-format').scrollIntoViewIfNeeded(); await settle(p, 300); }, rows: 'F4 answer format (no record-reference links); F5 web search CONFLICT (absent)' },
  { n: '14', slug: 'settings-prompt-catalogue', state: {}, go: async (p, v) => { await settingsTab('prompt')(p, v); await p.locator('#ai-prompt-skills').scrollIntoViewIfNeeded(); await settle(p, 300); }, rows: 'F6 tools offered; F8–F9 skill catalogue; F7, F10 CRUD / code / file / web lines CONFLICT (absent)' },
  { n: '15', slug: 'settings-prompt-context', state: {}, go: async (p, v) => { await settingsTab('prompt')(p, v); await p.locator('#ai-prompt-context').scrollIntoViewIfNeeded(); await settle(p, 300); }, rows: 'F11 context sent with each question: organisation date + timezone only, NO user name (rule 3.3)' },
  { n: '16', same: '03' }, { n: '17', same: '04' }, { n: '18', same: '05' }, { n: '19', same: '06' }, { n: '20', same: '07' },
  { n: '21', slug: 'chat-usage-popover', state: { conversation: 'answer' }, go: async (p, v) => { await chat('answer', TITLE)(p, v); await p.getByRole('button', { name: 'Context and usage' }).click(); await settle(p, 300); await p.locator('.ai-popover').getByRole('button', { name: 'More' }).click(); await settle(p, 400); }, rows: 'G7 context vs the Crewflow per-answer limit; G8 allowance + reset time; G9 More / Less; G10–G14 tokens, cached input and ESTIMATED cost (no credits, TW-D6); G15, G16, G24 CONFLICT (absent)' },
  { n: '22', slug: 'chat-empty-actions', state: {}, go: chat(), rows: 'H1 avatar; H2 title; H3 "Check coverage gaps"; H5 "See what I can do" (CD-8); H4 "Draft a shift" waits for approvals (P5); H7, H8 CONFLICT (absent)' },
  { n: '23', slug: 'chat-answer', state: { conversation: 'answer' }, go: chat('answer', TITLE), rows: 'H12 user bubble; H14 avatar + name + "AI" badge + time; H15–H21 safe Markdown (sized headings, quote, ordered list, code chips, rule); H23 code fence label; H22, H25 CONFLICT (no autonomous writes, no email offer)' },
  { n: '24', slug: 'panel-thinking', state: { conversation: 'thinking' }, stream: [], go: panel('thinking', 'Which shifts this weekend are unfilled?'), rows: 'I1–I4 panel header; I5 "{name} is thinking" with the thinking avatar; I8–I11 WhatsApp / create-record steps CONFLICT (absent)' },
  { n: '25', slug: 'panel-plan', state: { conversation: 'thinking' }, stream: STREAM_PLAN, go: panel('thinking', 'Which shifts this weekend are unfilled?'), rows: 'I12 "Planned N steps"; I13 checklist (information only); I16 step labels; I15 "Plan approved" CONFLICT (absent); I17 web search CONFLICT (absent)' },
  { n: '26', slug: 'panel-empty', state: {}, go: panel(), rows: 'I1, I3, I4; H1–H6 empty state in the side panel' },
  { n: '27', slug: 'agent-editor', state: {}, go: settingsTab('agents', '&agent=ag-1'), rows: 'J1–J4, J8, J10–J18, J21 storage-only editor; J9 Test and Runs SHOW AS DISABLED (EX-3, reason shown); J5–J7 variables / typed outputs CONFLICT (absent); J12, J19, J20 settings / delete / destroy permissions CONFLICT (absent)' },
  { n: '28', gallery: 'avatar-parts', rows: 'K1–K10 ORIGINAL faces, states and shapes (parametric SVG + CSS keyframes)' },
  { n: '29', gallery: 'avatar-matrix', rows: 'K11 10 colours × states + 3 small sizes; face/body contrast ≥ 3:1' },
  { n: '30', gallery: 'avatar-sizes', rows: 'K12–K14 AiAssistantAvatar({shape, colour, face, state, size, animate}); K15 accessory LATER' },
  { n: '31', gallery: 'avatar-sizes', scroll: 0.25, rows: 'K13–K14 sizes per colour' },
  { n: '32', gallery: 'avatar-sizes', scroll: 0.5, rows: 'K13–K14 sizes per colour' },
  { n: '33', gallery: 'avatar-sizes', scroll: 0.85, rows: 'K13–K14 sizes per colour' },
];

/** In-page accessibility checks (axe-core is not in the lockfile; see the handoff REPORT). */
async function a11y(page, scope) {
  return page.evaluate((scopeSel) => {
    const roots = [...document.querySelectorAll(scopeSel)];
    const problems = [];
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const nameOf = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.trim(); }
      if (el.closest('label')) return el.closest('label').textContent.trim();
      return (el.textContent || '').trim() || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    };
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="radio"], [role="menuitem"], [role="slider"], [role="switch"]')) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (!nameOf(el)) problems.push({ impact: 'serious', rule: 'accessible-name', el: el.outerHTML.slice(0, 120) });
    }
    const ids = {};
    for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
    for (const [id, n] of Object.entries(ids)) if (n > 1) problems.push({ impact: 'serious', rule: 'duplicate-id', el: id });
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x)); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    for (const el of roots.flatMap((r) => [...r.querySelectorAll('*')])) {
      if (!visible(el) || el.closest('[aria-hidden="true"]') || el.closest('svg')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) < 1 || el.closest(':disabled, [aria-disabled="true"]')) continue;
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      if (ratio < (large ? 3 : 4.5)) problems.push({ impact: ratio < 3 ? 'serious' : 'moderate', rule: 'color-contrast', ratio: Math.round(ratio * 100) / 100, text: el.textContent.trim().slice(0, 60) });
    }
    const hscroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    if (hscroll) problems.push({ impact: 'serious', rule: 'horizontal-scroll', el: `${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}` });
    const animated = [...document.querySelectorAll('.ai-av *')].filter((el) => getComputedStyle(el).animationName !== 'none').length;
    if (animated && matchMedia('(prefers-reduced-motion: reduce)').matches) problems.push({ impact: 'serious', rule: 'reduced-motion', el: `${animated} avatar parts still animate` });
    return problems;
  }, scope);
}

async function main() {
  const browser = await launch();
  const report = {};
  const produced = {};
  try {
    for (const shot of SHOTS) {
      if (ONLY.length && !ONLY.includes(shot.n)) continue;
      if (shot.same) { produced[shot.n] = { same: shot.same }; continue; }
      if (shot.gallery) {
        if (!GALLERY) { produced[shot.n] = { missing: 'AVATAR_GALLERY_DIR not set' }; continue; }
        for (const v of VARIANTS) {
          const theme = v.theme === 'dark' ? 'dark' : 'light';
          const file = path.join(GALLERY, `${shot.gallery}-${theme}.html`);
          const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
          const page = await ctx.newPage();
          await page.goto('file:///' + file.replace(/\\/g, '/'));
          await page.waitForTimeout(300);
          if (shot.scroll) await page.evaluate((f) => window.scrollTo(0, (document.body.scrollHeight - innerHeight) * f), shot.scroll);
          await page.screenshot({ path: path.join(OUT, `cf-${shot.n}-${shot.gallery}-${v.key}.png`) });
          await ctx.close();
        }
        produced[shot.n] = { slug: shot.gallery };
        continue;
      }
      for (const v of VARIANTS) {
        const { context, page, errors, fx } = await openPage(browser, { persona: 'ceo', theme: v.theme, viewport: v.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        page.setDefaultTimeout(8000);
        await installAi(page, shot.state);
        if (shot.stream) await captureStreamShim(page, shot.stream);
        try {
          await shot.go(page, v);
          await page.screenshot({ path: path.join(OUT, `cf-${shot.n}-${shot.slug}-${v.key}.png`) });
          report[`${shot.n}-${v.key}`] = { problems: await a11y(page, '.ai-settings-root, .ai-chat-body, .ai-panel-content, .ai-navigation, .ai-popover, .ai-capabilities'), pageErrors: errors, unhandled: fx.unhandled.filter((u) => !/realtime/.test(u)) };
        } catch (e) {
          // A failed step is reported (and fails the run) but never stops the other captures.
          await page.screenshot({ path: path.join(OUT, `debug-${shot.n}-${v.key}.png`) }).catch(() => undefined);
          report[`${shot.n}-${v.key}`] = { problems: [], pageErrors: [...errors, `capture step failed: ${String(e.message || e).split(String.fromCharCode(10))[0]}`], unhandled: fx.unhandled };
        }
        await context.close();
      }
      produced[shot.n] = { slug: shot.slug };
      process.stdout.write(`[ai-parity] ${shot.n} ${shot.slug}\n`);
    }
  } finally {
    await browser.close();
  }
  // The owner's Twenty references are copied next to compare.html so it works wherever the folder is moved.
  fs.mkdirSync(path.join(OUT, 'twenty'), { recursive: true });
  for (let i = 1; i <= 33; i++) {
    const n = String(i).padStart(2, '0');
    const src = path.join(TWENTY_SRC, `twenty-ai-${n}.png`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, 'twenty', `twenty-ai-${n}.png`));
  }
  fs.writeFileSync(path.join(OUT, 'a11y-report.json'), JSON.stringify(report, null, 2));
  writeCompare(produced);
  const serious = Object.entries(report).flatMap(([k, r]) => r.problems.filter((p) => p.impact === 'serious').map((p) => `${k} ${p.rule} ${p.el || p.text || ''} ${p.ratio || ''}`));
  const errs = Object.entries(report).flatMap(([k, r]) => [...r.pageErrors, ...r.unhandled].map((e) => `${k} ${e}`));
  process.stdout.write(`[ai-parity] serious a11y problems: ${serious.length}\n${serious.join('\n')}\n[ai-parity] page errors / unhandled: ${errs.length}\n${errs.join('\n')}\n`);
  if (serious.length || errs.length) process.exitCode = 1;
}

function writeCompare(produced) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = SHOTS.map((s) => {
    const src = s.same ? SHOTS.find((x) => x.n === s.same) : s;
    const slug = src.slug || src.gallery;
    const img = (k) => `cf-${src.n}-${slug}-${k}.png`;
    return `<section id="s${s.n}"><h2>${s.n}${s.same ? ` <small>(same state as ${s.same})</small>` : ''}</h2>
<div class="pair"><figure><img src="twenty/twenty-ai-${s.n}.png" alt="Twenty screenshot ${s.n}"><figcaption>Twenty (reference only)</figcaption></figure>
<figure><img src="${img('1440-light')}" alt="Crewflow capture for ${s.n}"><figcaption>Crewflow · <a href="${img('1440-light')}">1440 light</a> · <a href="${img('1440-dark')}">1440 dark</a> · <a href="${img('390-light')}">390 light</a></figcaption></figure></div>
<p class="rows">${esc(src.rows || '')}</p></section>`;
  }).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI parity review</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}h1{font-size:20px}section{border-top:1px solid var(--line);padding:16px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}figcaption,.rows{color:var(--muted);font-size:12.5px}
@media (max-width:760px){.pair{grid-template-columns:1fr}}a{color:inherit}</style></head><body>
<h1>Crewflow AI × Twenty — structure review</h1>
<p>Left: the owner’s Twenty screenshots (layout reference only — no Twenty name, colour, copy or artwork is used). Right: Crewflow’s real UI with fictional fixtures. Under each pair: the TWENTY_UI_INVENTORY rows and their status. Every visible difference is explained by a row status (BUILD ADAPTED, SHOW AS DISABLED with its reason, or CONFLICT = deliberately absent). Sign-off is for structure, not pixels.</p>
${rows}</body></html>`;
  fs.writeFileSync(path.join(OUT, 'compare.html'), html);
  fs.writeFileSync(path.join(OUT, 'produced.json'), JSON.stringify(produced, null, 2));
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  process.exit(1);
});
