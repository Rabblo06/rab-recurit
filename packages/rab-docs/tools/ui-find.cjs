#!/usr/bin/env node
/*
 * Tiny helper for driving the Android emulator: reads a `uiautomator dump`
 * XML file and prints the centre point of the first node whose text or
 * content-desc matches the given pattern (case-insensitive substring, or a
 * /regex/). Flutter exposes semantics labels as content-desc.
 *
 *   node ui-find.cjs dump.xml "Accept"          -> "540 2100"
 *   node ui-find.cjs dump.xml "/^Offers$/" 2    -> centre of the 2nd match
 *   node ui-find.cjs dump.xml --list            -> every labelled node + bounds
 */
'use strict';
const fs = require('fs');
const [, , file, pattern, nth = '1'] = process.argv;
const xml = fs.readFileSync(file, 'utf8');
const nodes = [];
const re = /<node [^>]*?>/g;
let m;
while ((m = re.exec(xml))) {
  const tag = m[0];
  const attr = (name) => {
    const a = tag.match(new RegExp(`${name}="([^"]*)"`));
    return a ? a[1].replace(/&#10;/g, ' ').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"') : '';
  };
  const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!b) continue;
  const [x1, y1, x2, y2] = b.slice(1).map(Number);
  nodes.push({ text: attr('text'), desc: attr('content-desc'), cls: attr('class'), clickable: attr('clickable'), x1, y1, x2, y2 });
}
if (pattern === '--list') {
  for (const n of nodes) {
    const label = [n.text, n.desc].filter(Boolean).join(' | ');
    if (label) console.log(`[${n.x1},${n.y1}][${n.x2},${n.y2}] ${n.clickable === 'true' ? '*' : ' '} ${label}`);
  }
  process.exit(0);
}
const matcher = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0
  ? ((r) => (s) => r.test(s))(new RegExp(pattern.slice(1, pattern.lastIndexOf('/')), pattern.slice(pattern.lastIndexOf('/') + 1) || 'i'))
  : (s) => s.toLowerCase().includes(pattern.toLowerCase());
const hits = nodes.filter((n) => matcher(n.text) || matcher(n.desc));
const hit = hits[Number(nth) - 1];
if (!hit) {
  console.error(`not found: ${pattern}`);
  process.exit(1);
}
console.log(`${Math.round((hit.x1 + hit.x2) / 2)} ${Math.round((hit.y1 + hit.y2) / 2)}`);
