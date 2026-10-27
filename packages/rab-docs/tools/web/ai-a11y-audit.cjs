// U8 in-page accessibility audit for the AI surfaces (axe-core is NOT in the lockfile and stays held for the owner).
// Runs inside the page (Playwright `page.evaluate`): accessible names, duplicate ids, text contrast (WCAG AA: 4.5:1, 3:1
// for large text), no horizontal scroll, no running animation under prefers-reduced-motion, and the visible focus
// indicator of keyboard stops. Contrast failures whose text colour IS the `--font-tertiary` token are reported apart: that
// token is an open owner decision (index.css is not changed here).
'use strict';

/** The AI roots audited on a page (chat page, Ask AI panel, popovers/menus in portals, sheets, cards). */
const AI_ROOTS = '.ai-chat-body, .ai-panel-content, .ai-navigation, .ai-popover, .ai-skill-menu, .ai-capabilities, .ai-dcard';

async function auditPage(page, scope = AI_ROOTS) {
  return page.evaluate((scopeSel) => {
    const roots = [...document.querySelectorAll(scopeSel)];
    const problems = [];
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const inScope = (el) => roots.some((r) => r.contains(el));
    const nameOf = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.trim(); }
      if (el.closest('label')) return el.closest('label').textContent.trim();
      return (el.textContent || '').trim() || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    };
    const interactive = 'button, a[href], input, select, textarea, [role="tab"], [role="radio"], [role="menuitem"], [role="menuitemcheckbox"], [role="slider"], [role="switch"], [role="separator"][tabindex]';
    for (const el of document.querySelectorAll(interactive)) {
      if (!inScope(el) || !visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (!nameOf(el)) problems.push({ impact: 'serious', rule: 'accessible-name', el: el.outerHTML.slice(0, 140) });
    }
    for (const el of document.querySelectorAll('[role="region"], [role="dialog"], [role="menu"], section[aria-labelledby]')) {
      if (!inScope(el) || !visible(el)) continue;
      if (!nameOf(el) && !el.getAttribute('aria-labelledby')) problems.push({ impact: 'serious', rule: 'landmark-name', el: el.outerHTML.slice(0, 120) });
    }
    const ids = {};
    for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
    for (const [id, n] of Object.entries(ids)) if (n > 1) problems.push({ impact: 'serious', rule: 'duplicate-id', el: id });
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x)); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; } return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }; };
    const probe = document.createElement('span');
    probe.style.color = 'var(--font-tertiary)';
    document.body.appendChild(probe);
    const tertiary = getComputedStyle(probe).color;
    probe.remove();
    for (const el of roots.flatMap((r) => [r, ...r.querySelectorAll('*')])) {
      if (!visible(el) || el.closest('[aria-hidden="true"]') || el.closest('svg') || el.closest('.visually-hidden')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) < 1 || el.closest(':disabled, [aria-disabled="true"], del')) continue;
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        const owner = cs.color === tertiary;
        problems.push({ impact: owner ? 'owner-decision' : ratio < 3 ? 'serious' : 'moderate', rule: owner ? 'color-contrast (--font-tertiary)' : 'color-contrast', ratio: Math.round(ratio * 100) / 100, text: el.textContent.trim().slice(0, 60) });
      }
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      problems.push({ impact: 'serious', rule: 'horizontal-scroll', el: `${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}` });
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const moving = roots.flatMap((r) => [r, ...r.querySelectorAll('*')]).filter((el) => {
        const cs = getComputedStyle(el);
        return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0 && cs.animationPlayState !== 'paused';
      });
      if (moving.length) problems.push({ impact: 'serious', rule: 'reduced-motion', el: moving.slice(0, 5).map((m) => m.className && String(m.className.baseVal ?? m.className)).join(' | ') });
    }
    return problems;
  }, scope);
}

/**
 * Tabs through the page (up to `maxStops`) and records every stop inside the AI roots that has NO visible focus indicator
 * (outline, or a box-shadow ring). Returns { stops, missing }.
 */
async function focusAudit(page, maxStops = 60, scope = AI_ROOTS) {
  const stops = [];
  const missing = [];
  for (let i = 0; i < maxStops; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate((scopeSel) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const inside = [...document.querySelectorAll(scopeSel)].some((r) => r.contains(el));
      const cs = getComputedStyle(el);
      // The composer's textarea shows focus on its frame (.ai-composer:focus-within border), not on itself.
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none') || (el.tagName === 'TEXTAREA' && !!el.closest('.ai-composer'));
      const label = el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) || (el.textContent || '').trim().slice(0, 40) || el.getAttribute('placeholder') || `${el.tagName.toLowerCase()}[type=${el.getAttribute('type') || ''}]`;
      return { inside, ring, label: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${label}"`, focusVisible: el.matches(':focus-visible') };
    }, scope);
    if (!info) continue;
    if (!info.inside) continue;
    stops.push(info.label);
    if (!info.ring) missing.push(info.label);
  }
  return { stops: [...new Set(stops)], missing: [...new Set(missing)] };
}

module.exports = { AI_ROOTS, auditPage, focusAudit };
