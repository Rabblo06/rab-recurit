#!/usr/bin/env node
/**
 * SQL-injection lint (M0 §6.4 control 10; owner-login architecture: one injected statement runs with the schema owner's
 * privileges — catalogue BC-01). CI fails on any NEW dynamically built SQL that has not been reviewed.
 *
 * What it flags, in production TypeScript under packages/rab-server/src and packages/rab-worker/src (specs, __tests__ and
 * the frozen core migrations are excluded — migrations interpolate code constants only and are never edited after merge):
 *   sql-template   a template literal containing `${…}` whose static text looks like SQL (an upper-case SQL keyword:
 *                  SELECT, INSERT INTO, UPDATE … SET, DELETE FROM, WHERE, JOIN, ORDER BY, GROUP BY, LIMIT, OFFSET,
 *                  RETURNING, VALUES, set_config, …) — covers `query(`/`execute(` call arguments AND SQL assembled into a
 *                  variable first;
 *   ddl-identifier a template literal containing `${…}` with DDL / privilege text (CREATE, ALTER, DROP, GRANT, REVOKE,
 *                  TRUNCATE, COMMENT ON, SET ROLE, SET LOCAL, LOCK, ANALYZE, REINDEX, VACUUM) — identifiers cannot be
 *                  bound as parameters, so each needs an identifier allow-list or format('%I');
 *   where-builder  a dynamic WHERE / AND / OR / ORDER BY assembled by concatenation or join (`' AND '`, `' OR '`,
 *                  `'WHERE ' +`, `.join(' AND ')`, `+ ' ORDER BY '`).
 * A site passes only with a REVIEWED allow-comment on the same line or the line directly above the template / expression:
 *     // sql-injection-reviewed: <why every interpolated value is a code constant, a validated identifier or a $n placeholder>
 * The reason must be at least 20 characters. The tool prints file:line, the rule and the first interpolation.
 *
 *   node tools/check-sql-injection.cjs            # exit 1 when an unreviewed site exists
 *   node tools/check-sql-injection.cjs --list     # print every site, reviewed or not (for review)
 *
 * LIMITS (stated, this is NOT a complete defence): it is a text scan, not a parser or a taint analysis. It cannot see SQL
 * built across functions, read from data, assembled with String.prototype methods other than the patterns above, passed
 * through an ORM API it does not know (QueryBuilder `.where(string)`, `.orderBy(string)`, raw `sql` fragments), or a
 * reviewed comment that has gone stale after an edit. The defences that do not depend on it: parameter binding ($n) for
 * every value, identifier allow-lists / format('%I') in SQL, class-validator DTOs with forbidNonWhitelisted, the adversarial
 * tests (sql-injection-adversarial*.spec.ts), and the semantic posture monitor that detects what an injection changed.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['packages/rab-server/src', 'packages/rab-worker/src'];
const EXCLUDE = [/\.spec\.ts$/, /\.test\.ts$/, /[\\/]__tests__[\\/]/, /[\\/]database[\\/]typeorm[\\/]core[\\/]migrations[\\/]/, /[\\/]gated-migrations[\\/]/, /\.d\.ts$/];
const ALLOW = /sql-injection-reviewed:\s*(.{20,})/;
/**
 * File-level review, honoured ONLY under packages/rab-server/src/database/ (SQL-definition modules, checks and operator
 * scripts that interpolate code constants: migration SQL builders, posture / invariant queries). Never for request-path
 * code (modules/, engine/, command/, the Worker): there every site needs its own reviewed comment.
 */
const ALLOW_FILE = /sql-injection-reviewed-file:\s*(.{20,})/;
const FILE_ALLOW_SCOPE = /^packages\/rab-server\/src\/database\//;
/** A template that is the message of an error / log / problem line (prose that names SQL), not SQL text. */
const MESSAGE_CALL = /(Error|refuse|log|warn|error|info|debug|push|reject|describe|it|fail)\(\s*$/;

const SQL_TEXT = /\b(SELECT|INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|WHERE|JOIN|ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET|RETURNING|VALUES|set_config|current_setting|ON\s+CONFLICT)\b/;
const DDL_TEXT = /\b(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COMMENT\s+ON|SET\s+ROLE|SET\s+LOCAL|LOCK\s+TABLE|ANALYZE|REINDEX|VACUUM|SECURITY\s+DEFINER)\b/;
const WHERE_BUILDER = /(['"`]\s*(AND|OR)\s*['"`]\s*\)|\.join\(\s*['"`]\s*(AND|OR)\s*['"`]\s*\)|['"`][^'"`\n]*\bWHERE\s*['"`]\s*\+|\+\s*['"`]\s*(AND|OR|WHERE|ORDER\s+BY)\b)/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(p, out);
    } else if (entry.name.endsWith('.ts') && !EXCLUDE.some((re) => re.test(p))) out.push(p);
  }
}

/** Template literals with their start line and static text (interpolations replaced by ${}), nesting-aware. */
function templates(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  // Skip strings / comments outside templates so a backtick inside them is not taken as a template start.
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === "'" || c === '"') { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; } i++; continue; }
    if (c === '`') {
      const res = readTemplate(src, i, line, line);
      out.push(...res.found);
      i = res.end;
      line = res.line;
      continue;
    }
    i++;
  }
  return out;
}

/** `anchor` = start line of the OUTERMOST template: a review comment must sit above it, never inside SQL text. */
function readTemplate(src, start, startLine, anchor) {
  let i = start + 1;
  let line = startLine;
  let text = '';
  const exprs = [];
  const found = [];
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { text += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
    if (src[i] === '\n') line++;
    if (src[i] === '$' && src[i + 1] === '{') {
      // Read the expression, honouring nested braces, strings and templates.
      i += 2;
      let depth = 1;
      let expr = '';
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '`') { const inner = readTemplate(src, i, line, anchor); found.push(...inner.found); expr += src.slice(i, inner.end); line = inner.line; i = inner.end; continue; }
        if (ch === "'" || ch === '"') { const q = ch; let j = i + 1; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } expr += src.slice(i, j + 1); i = j + 1; continue; }
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
        if (ch === '\n') line++;
        expr += ch;
        i++;
      }
      exprs.push(expr.trim());
      text += '${}';
      continue;
    }
    text += src[i];
    i++;
  }
  found.unshift({ line: startLine, endLine: line, anchor, text, exprs, start });
  return { end: i + 1, line, found };
}

function reviewed(lines, lineNo) {
  for (const l of [lines[lineNo - 1], lines[lineNo - 2]]) {
    if (l && ALLOW.test(l)) return true;
  }
  return false;
}

function scan() {
  const files = [];
  for (const d of SCAN) walk(path.join(ROOT, d), files);
  const sites = [];
  for (const file of files.sort()) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const fileReviewed = FILE_ALLOW_SCOPE.test(rel) && ALLOW_FILE.test(src.slice(0, 4000));
    const all = templates(src);
    for (const t of all) {
      if (t.exprs.length === 0) continue;
      if (MESSAGE_CALL.test(src.slice(Math.max(0, t.start - 40), t.start))) continue;
      const rule = DDL_TEXT.test(t.text) ? 'ddl-identifier' : SQL_TEXT.test(t.text) ? 'sql-template' : null;
      if (!rule) continue;
      sites.push({ file: rel, line: t.line, anchor: t.anchor, rule, expr: t.exprs[0].slice(0, 60), reviewed: fileReviewed || reviewed(lines, t.anchor) });
    }
    lines.forEach((l, idx) => {
      const lineNo = idx + 1;
      if (!WHERE_BUILDER.test(l) || /^\s*(\/\/|\*)/.test(l)) return;
      // A builder line inside a template's text belongs to that template (flagged above if it interpolates).
      if (all.some((t) => lineNo > t.line && lineNo <= t.endLine)) return;
      const opening = all.find((t) => t.line === lineNo);
      const anchor = opening ? opening.anchor : lineNo;
      sites.push({ file: rel, line: lineNo, anchor, rule: 'where-builder', expr: l.trim().slice(0, 60), reviewed: fileReviewed || reviewed(lines, anchor) });
    });
  }
  return sites;
}

if (require.main === module) {
  const sites = scan();
  const open = sites.filter((s) => !s.reviewed);
  const list = process.argv.includes('--list');
  for (const s of list ? sites : open) {
    console.log(`${s.reviewed ? 'reviewed ' : 'UNREVIEWED'} ${s.rule.padEnd(14)} ${s.file}:${s.line}  \${${s.expr}}`);
  }
  console.log(`[sql-injection-lint] ${sites.length} dynamic SQL site(s), ${sites.length - open.length} reviewed, ${open.length} unreviewed. (A text scan, not a complete defence: see the header.)`);
  process.exit(open.length ? 1 : 0);
}

module.exports = { scan, templates };
