// Generates developers/api-reference/endpoints.mdx from the real NestJS controllers.
// Crewflow has no OpenAPI/Swagger generation, so this reads the controller source with the
// TypeScript compiler API and lists every route, its guards and its permission flags.
// Nothing is invented: a route only appears if a controller declares it.
//
// Run from the repo root:  node packages/rab-docs/tools/generate-api-reference.cjs
const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '../../..');
const srcRoot = path.join(repo, 'packages/rab-server/src');
const outFile = path.resolve(__dirname, '../developers/api-reference/endpoints.mdx');

const HTTP = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Sse: 'GET (SSE)' };

// Domain grouping, in display order. First matching rule wins.
const GROUPS = [
  ['Authentication', /core-modules\/auth\//],
  ['Profile and sessions', /identity\/controllers\/profile/],
  ['Workspace settings and roles', /identity\/controllers\/(workspace|role)/],
  ['Platform administration', /(platform-admin\/|organisation-onboarding)/],
  ['Manager workspaces', /manager-workspace\//],
  ['Managers and venue managers', /modules\/manager\//],
  ['Staff', /modules\/staff\//],
  ['Venues', /modules\/venue\//],
  ['Job roles and shifts', /modules\/scheduling\//],
  ['Offers and replacements', /modules\/offer\//],
  ['Attendance and timesheets', /modules\/attendance\//],
  ['Notifications and push', /(modules\/notification\/|core-modules\/push\/)/],
  ['Real-time', /core-modules\/realtime\//],
  ['Files', /core-modules\/storage\//],
  ['Audit', /core-modules\/audit\//],
  ['Dashboard and search', /modules\/(dashboard|search)\//],
  ['Health', /core-modules\/health\//],
];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      walk(p, acc);
    } else if (e.name.endsWith('.controller.ts')) acc.push(p);
  }
  return acc;
}

const decoratorsOf = (node) => (ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : []);
const callName = (d) => {
  const e = d.expression;
  if (ts.isCallExpression(e)) return e.expression.getText();
  return e.getText();
};
const firstStringArg = (d) => {
  const e = d.expression;
  if (!ts.isCallExpression(e) || !e.arguments.length) return '';
  const a = e.arguments[0];
  if (ts.isStringLiteralLike(a)) return a.text;
  if (ts.isArrayLiteralExpression(a) && a.elements[0] && ts.isStringLiteralLike(a.elements[0])) return a.elements[0].text;
  return '';
};

// Collect PermissionFlag.X references and named guards from @UseGuards / custom decorators.
function guardInfo(decorators) {
  const flags = new Set();
  const guards = new Set();
  const notes = new Set();
  for (const d of decorators) {
    const name = callName(d);
    const text = d.expression.getText();
    for (const m of text.matchAll(/PermissionFlag\.([A-Z_]+)/g)) flags.add(m[1]);
    if (name === 'UseGuards') {
      for (const m of text.matchAll(/\b([A-Z][A-Za-z]+Guard)\b/g)) guards.add(m[1]);
    } else if (name === 'ManagerApplication') {
      notes.add('Manager web app only');
    } else if (name === 'Throttle') {
      notes.add('Rate limited');
    } else if (name === 'Public' || name === 'SkipAuth') {
      notes.add('Public');
    }
  }
  return { flags, guards, notes };
}

// Real flag values, read from @rab/shared so the docs show exactly what the server checks.
const FLAG_VALUES = Object.fromEntries(
  [...fs.readFileSync(path.join(repo, 'packages/rab-shared/src/constants/permission-flags.ts'), 'utf8')
    .matchAll(/^\s*([A-Z_]+):\s*'([a-z_.]+)'/gm)].map((m) => [m[1], m[2]]),
);
const flagLabel = (f) => {
  if (!FLAG_VALUES[f]) throw new Error(`Unknown PermissionFlag.${f} — update permission-flags parsing`);
  return FLAG_VALUES[f];
};

function parseController(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const routes = [];
  ts.forEachChild(sf, function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const cDecs = decoratorsOf(node);
      const ctrl = cDecs.find((d) => callName(d) === 'Controller');
      if (!ctrl) return;
      const prefix = firstStringArg(ctrl);
      const classInfo = guardInfo(cDecs);
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m)) continue;
        const mDecs = decoratorsOf(m);
        const verb = mDecs.find((d) => HTTP[callName(d)]);
        if (!verb) continue;
        const sub = firstStringArg(verb);
        const info = guardInfo(mDecs);
        const full = '/' + [prefix, sub].filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
        const flags = [...new Set([...classInfo.flags, ...info.flags])].map(flagLabel);
        const guards = [...new Set([...classInfo.guards, ...info.guards])].filter((g) => !/^PermissionGuard$/.test(g));
        const notes = [...new Set([...classInfo.notes, ...info.notes])];
        routes.push({ method: HTTP[callName(verb)], path: full, handler: m.name.getText(), flags, guards, notes });
      }
    }
    ts.forEachChild(node, visit);
  });
  return routes;
}

const files = walk(srcRoot).sort();
const byGroup = new Map(GROUPS.map(([g]) => [g, []]));
byGroup.set('Other', []);
let total = 0;
for (const file of files) {
  const rel = path.relative(repo, file).replace(/\\/g, '/');
  const group = (GROUPS.find(([, re]) => re.test(rel)) || ['Other'])[0];
  const routes = parseController(file);
  total += routes.length;
  if (routes.length) byGroup.get(group).push({ rel, routes });
}

const esc = (s) => s.replace(/\|/g, '\\|').replace(/[{}<>]/g, (c) => ({ '{': '&#123;', '}': '&#125;', '<': '&lt;', '>': '&gt;' })[c]);
const pathCell = (p) => '`' + p.replace(/:(\w+)/g, ':$1') + '`';

let mdx = `---
title: "API endpoints"
description: "Every REST endpoint the Crewflow server declares, with its guards and permission flags. Generated from the controller source."
icon: "list"
---

{/* GENERATED FILE — do not edit by hand. Run: node packages/rab-docs/tools/generate-api-reference.cjs */}

This list is generated from the NestJS controllers in \`packages/rab-server/src\`. It contains **${total} endpoints** across **${files.length} controller files**. Paths are shown exactly as declared; there is no global prefix, so each controller includes \`rest/v1\` in its own path. The only exception is the health check.

<Note>
  The **Permission** column lists the permission flags required by the route's guards. Service-level checks (for example "own organisation's CEO only") are not visible here — read the service. Every authenticated route also passes the sign-in guard chain described in [Authentication flow](/developers/authentication-flow).
</Note>

`;

for (const [group, ctrls] of byGroup) {
  if (!ctrls.length) continue;
  mdx += `## ${group}\n\n`;
  for (const { rel, routes } of ctrls) {
    mdx += `<Accordion title="${path.basename(rel)}" description="${routes.length} endpoint${routes.length === 1 ? '' : 's'}" defaultOpen>\n\n`;
    mdx += `Source: \`${rel}\`\n\n`;
    mdx += `| Method | Path | Permission | Guards and notes | Handler |\n| --- | --- | --- | --- | --- |\n`;
    for (const r of routes) {
      const perm = r.flags.length ? r.flags.map((f) => '`' + f + '`').join(' ') : '—';
      const extra = [...r.guards, ...r.notes].map(esc).join(', ') || '—';
      mdx += `| ${r.method} | ${pathCell(r.path)} | ${perm} | ${extra} | \`${r.handler}\` |\n`;
    }
    mdx += `\n</Accordion>\n\n`;
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, mdx);
console.log(`wrote ${path.relative(repo, outFile)}: ${total} endpoints from ${files.length} controllers`);
for (const [g, c] of byGroup) if (c.length) console.log(`  ${g}: ${c.reduce((n, x) => n + x.routes.length, 0)}`);
