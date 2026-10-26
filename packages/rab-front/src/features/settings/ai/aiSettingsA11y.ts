/**
 * TEST-ONLY in-page accessibility sweep for the Settings → AI specs (imported by *.spec.tsx only). `@axe-core/playwright`
 * is not approved, so this checks the rules these screens depend on directly in the DOM:
 *   - every id is unique, and every aria-labelledby / aria-describedby / aria-controls reference resolves;
 *   - every button, link, switch, meter, tab and form control has an accessible name;
 *   - every table has a caption or an aria-label;
 *   - every disabled action that explains itself points at its reason (title or aria-describedby).
 * Returns the problems as strings, so a failing spec says exactly what is wrong.
 */
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function nameOf(el: Element, doc: Document): string {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) return labelledby.split(/\s+/).map((id) => text(doc.getElementById(id))).join(' ').trim();
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  const id = el.getAttribute('id');
  if (id && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
    const label = Array.from(doc.querySelectorAll('label')).find((l) => l.htmlFor === id);
    if (label && text(label)) return text(label);
  }
  const wrapping = el.closest('label');
  if (wrapping && text(wrapping)) return text(wrapping);
  if (el instanceof HTMLButtonElement || el.getAttribute('role') === 'tab' || el instanceof HTMLAnchorElement) return text(el);
  return el.getAttribute('title')?.trim() ?? '';
}

export function a11ySweep(root: ParentNode = document.body): string[] {
  const doc = document;
  const problems: string[] = [];
  const ids = new Map<string, number>();
  root.querySelectorAll('[id]').forEach((el) => ids.set(el.id, (ids.get(el.id) ?? 0) + 1));
  ids.forEach((n, id) => { if (n > 1) problems.push(`duplicate id "${id}" (${n}×)`); });
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
        if (!doc.getElementById(id)) problems.push(`${attr}="${id}" on <${el.tagName.toLowerCase()}> points nowhere`);
      }
    });
  }
  root.querySelectorAll('button, a[href], [role="switch"], [role="meter"], [role="tab"], [role="radio"], input:not([type="hidden"]), select, textarea').forEach((el) => {
    if (!nameOf(el, doc)) problems.push(`<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}${el.className ? ` class="${el.className}"` : ''}> has no accessible name`);
  });
  root.querySelectorAll('table').forEach((t) => {
    if (!text(t.querySelector('caption')) && !t.getAttribute('aria-label')) problems.push('a table has no caption or aria-label');
  });
  root.querySelectorAll('img').forEach((img) => { if (!img.hasAttribute('alt')) problems.push('an <img> has no alt'); });
  return problems;
}

/** Disabled controls that must carry their reason (EX-3, "can't be deleted"): a title or a description that resolves. */
export function disabledWithoutReason(root: ParentNode = document.body, names: RegExp): string[] {
  const out: string[] = [];
  root.querySelectorAll('button:disabled, [aria-disabled="true"]').forEach((el) => {
    const name = nameOf(el, document);
    if (!names.test(name)) return;
    const described = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).join(' ');
    if (!el.getAttribute('title') && !described) out.push(`disabled "${name}" gives no reason`);
  });
  return out;
}
