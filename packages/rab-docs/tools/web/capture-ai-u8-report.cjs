// U8 hardening report page: reads the in-page audit results the U8 Playwright run wrote (U8_OUT/report.json, focus-*.json
// and one screenshot per audited state) and writes compare.html — every AI state × light/dark × 1440/390 with its audit
// result, the keyboard stops, the contrast items that wait for the owner's --font-tertiary decision, and the remaining
// mockup gaps with their reasons. No backend, no model, no real data (the run used the fictional fixtures).
//
//   U8_OUT=<dir> node packages/rab-docs/tools/web/capture-ai-u8-report.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = process.env.U8_OUT;
if (!OUT) throw new Error('U8_OUT is required');
const report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));
const focus = ['light', 'dark'].map((t) => {
  const f = path.join(OUT, `focus-${t}.json`);
  return { theme: t, ...(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { stops: [], missing: [] }) };
});
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const GAPS = [
  ['@mention ("@Ada")', 'Not built. Asking is the composer itself; the assistant’s name is shown with the AI badge on every answer.', 'Owner decision 7 scope (not in U2–U8).'],
  ['👍 / 👎 on answers', 'Not built: there is no feedback route; a button that does nothing would be fake.', 'Owner decision 7.'],
  ['Tool step timings ("· 182 ms")', 'Not shown: not in any contract.', 'Owner decision 8.'],
  ['Expanded tool input / output', 'Never shown; steps open to server facts only.', 'Owner decision 2 (rule 11.2).'],
  ['"Plan approved" step', 'Not shown: approval is per proposal card, never of a plan.', 'Phase 5 rule (approval is per write).'],
  ['Benchmarks (intelligence, speed, "Answer 100 questions")', 'Shown as "—" with "No verified source yet".', 'Owner rules U1/5.'],
  ['£ icons', 'US dollars only.', 'Owner rule (USD only).'],
  ['Avatar shapes / face picker', 'Round avatar only; states idle, thinking, waiting, happy/ack, error, sleepy.', 'Owner decisions 2026-10-26.'],
  ['Staff record chips', 'Plain text "a staff member": no read tool returns a staff profile id yet and there is no web read route.', 'S2 (Batch 3).'],
  ['--font-tertiary contrast (light theme)', 'Listed below per state, not changed: index.css is untouched.', 'Open owner decision.'],
];

const keys = Object.keys(report).sort();
const rows = keys.map((k) => {
  const v = report[k];
  const fail = v.filter((p) => p.impact === 'serious' || p.impact === 'moderate');
  const owner = v.filter((p) => p.impact === 'owner-decision');
  const img = fs.existsSync(path.join(OUT, `${k}.png`)) ? `<a href="${esc(k)}.png"><img src="${esc(k)}.png" alt="${esc(k)}" loading="lazy"></a>` : '';
  return `<tr><td><code>${esc(k)}</code></td><td>${fail.length ? `<b class="bad">${fail.length}</b><br>${fail.map((p) => esc(`${p.rule}: ${p.text || p.el || ''} ${p.ratio ?? ''}`)).join('<br>')}` : '<span class="ok">0</span>'}</td><td>${owner.length}${owner.length ? `<br><small>${esc([...new Set(owner.map((p) => `${p.text} (${p.ratio}:1)`))].slice(0, 8).join(' · '))}</small>` : ''}</td><td>${img}</td></tr>`;
});
const totalFail = keys.reduce((n, k) => n + report[k].filter((p) => p.impact === 'serious' || p.impact === 'moderate').length, 0);

fs.writeFileSync(path.join(OUT, 'compare.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>U8 hardening</title>
<style>:root{--bg:#fff;--fg:#24252b;--muted:#646873;--line:#e5e7eb;--ok:#1f7a3a;--bad:#b42318}@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececee;--muted:#b1b5be;--line:#34363d;--ok:#5cc983;--bad:#ff8a80}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0 20px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
img{width:220px;height:auto;border:1px solid var(--line);border-radius:6px}.ok{color:var(--ok)}.bad{color:var(--bad)}small{color:var(--muted)}code{font-size:12px}.wrap{overflow-x:auto}</style></head><body>
<h1>U8 — hardening</h1>
<p>Every AI surface in the real rab-front (fictional fixtures), light and dark, 1440 and 390 px, with reduced motion on. In-page audit (axe is not installed): accessible names, landmark names, duplicate ids, WCAG AA text contrast, horizontal scroll, running animations. Failing items: <b class="${totalFail ? 'bad' : 'ok'}">${totalFail}</b>. Contrast of text drawn in <code>--font-tertiary</code> is listed apart: that token is an open owner decision and index.css is not changed.</p>
<h2>Audit per state</h2><div class="wrap"><table><thead><tr><th>State · theme · width</th><th>Failing (serious / moderate)</th><th>--font-tertiary items (owner decision)</th><th>Screenshot</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<h2>Keyboard (Tab through the chat with an answer and an approval card)</h2>
${focus.map((f) => `<h3>${f.theme}</h3><p>${f.stops.length} AI stops; without a visible focus indicator: <b class="${f.missing.length ? 'bad' : 'ok'}">${f.missing.length}</b></p><ol>${f.stops.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`).join('')}
<h2>Remaining mockup gaps</h2><table><thead><tr><th>Mockup</th><th>Crewflow</th><th>Why</th></tr></thead><tbody>${GAPS.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td></tr>`).join('')}</tbody></table>
</body></html>`);
process.stdout.write(`[u8] states: ${keys.length}, failing: ${totalFail}\n`);
