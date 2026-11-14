#!/usr/bin/env node
/**
 * Workspace-table qualification ratchet (Part C2-0, HWS-AUDIT-C2-SIZING.md §7 layer 1).
 *
 * Goal of Part C2 (Twenty style): every runtime query names a workspace business table schema-qualified, through the
 * runtime primitive `businessTables(manager)` (packages/rab-server/src/engine/core-modules/tenant/business-tables.ts):
 *     const t = businessTables(manager);  manager.query(`SELECT … FROM ${t.shift} s …`)
 * instead of relying on the transaction-local search_path. This check stops NEW unqualified references while the module PRs
 * (C2-2 … C2-6b) convert the existing ones, and shrinks to an empty baseline in C2-7.
 *
 * It parses production TypeScript under packages/rab-server/src and packages/rab-worker/src with the TypeScript compiler API
 * (comments are never seen; `+` chains and `[…].join()` are merged into one SQL unit). Excluded: specs, __tests__, test
 * helpers, core migrations, gated migrations, and packages/rab-server/src/database/typeorm/workspace-schema/** (DDL,
 * template and provisioning code that already takes the schema explicitly; §2.4). Rules, per site:
 *   unqualified           FROM / JOIN / INTO / UPDATE / TABLE / ONLY <workspace table> with no schema, in a string or template
 *                         that contains an upper-case SQL keyword;
 *   core-qualified        core.<workspace table> / "core".<workspace table> (the legacy pre-cutover copies);
 *   other-qualified       any other qualifier — `${schema}.shift`, `"${q}".shift`, public.shift — that is not exactly the
 *                         primitive form `${t.<table>}` / `${tables.<table>}`;
 *   qb-string-table       a string table argument to a QueryBuilder from / into / update / delete / *join* call;
 *   search-path-switch    set_config('search_path' … / SET [LOCAL] search_path outside the binders in SEARCH_PATH_BINDERS;
 *   global-entity-access  getRepository(<workspace entity>), @InjectRepository(<workspace entity>) or
 *                         <dataSource|connection>.manager.<method>(<workspace entity>): a repository / manager that is not the
 *                         transaction's schema-bound manager.
 * Workspace tables come from database/typeorm/workspace-schema/workspace-tables.ts (WORKSPACE_TABLES); workspace entities
 * are the @Entity classes mapped to one of them without a `schema` option.
 *
 * Ratchet: tools/workspace-table-qualified.baseline.json records, per file and rule, how many sites exist today. The check
 * FAILS when a file/rule has MORE sites than its baseline (a new unqualified reference: qualify it with businessTables()), and
 * also when it has FEWER (a stale baseline: lower the entry, or delete it at zero, in the same PR). The baseline may only
 * shrink; C2-7 asserts it is empty.
 *
 *   node tools/check-workspace-table-qualified.cjs                    # exit 1 on a new site or a stale baseline entry
 *   node tools/check-workspace-table-qualified.cjs --list             # print every site (for the module PRs)
 *   node tools/check-workspace-table-qualified.cjs --write-baseline   # rewrite the baseline; refuses to GROW any entry
 *
 * LIMITS (stated): SQL assembled across functions from variables, a second table in a comma-separated FROM list, a table
 * name read from data and lower-case SQL keywords are not seen; counts are per file and rule, so moving a site inside a file
 * is not a change. The runtime layer covers what this cannot: the search_path trap (CREWFLOW_TEST_SEARCH_PATH_TRAP=true,
 * NODE_ENV=test) makes every binder bind search_path '' so any unqualified table fails with 42P01 in the integration suites.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['packages/rab-server/src', 'packages/rab-worker/src'];
const TABLES_FILE = 'packages/rab-server/src/database/typeorm/workspace-schema/workspace-tables.ts';
const BASELINE_FILE = path.join(__dirname, 'workspace-table-qualified.baseline.json');
const EXCLUDE = [
  /\.spec\.ts$/, /\.test\.ts$/, /\.e2e-spec\.ts$/, /\.d\.ts$/, /[\\/]__tests__[\\/]/, /[\\/]test[\\/]/, /[\\/]testing[\\/]/,
  /[\\/]migrations[\\/]/, /[\\/]gated-migrations[\\/]/, /[\\/]database[\\/]typeorm[\\/]workspace-schema[\\/]/,
];
/**
 * The binders that set search_path themselves (§2.3) — each also records the schema for businessTables(manager) and honours
 * the trap. Adding a file here is a reviewed change: it must take the schema only from the registry or the constant 'core'.
 */
const SEARCH_PATH_BINDERS = Object.freeze([
  'packages/rab-server/src/engine/core-modules/tenant/tenant-context.service.ts',
  'packages/rab-server/src/engine/core-modules/tenant/workspace-execution-context.ts',
  'packages/rab-server/src/engine/core-modules/user-deletion/user-deletion.service.ts',
  'packages/rab-server/src/command/seed-ai-demo.command.ts',
  'packages/rab-worker/src/queues/rab-maintenance/account-invite-cleanup.job.ts',
  'packages/rab-server/src/modules/manager/services/organisation-onboarding.service.ts',
  // Not business-table binders: the upgrade command runner pins search_path to pg_catalog for a command and restores it;
  // the operator-run owner bootstrap pins its own session to pg_catalog, pg_temp.
  'packages/rab-server/src/engine/core-modules/upgrade/workspace-command-runner.ts',
  'packages/rab-server/src/database/typeorm/scripts/owner-login/owner-bootstrap-sql.ts',
]);
const RULES = Object.freeze(['unqualified', 'core-qualified', 'other-qualified', 'qb-string-table', 'search-path-switch', 'global-entity-access']);

let tsModule = null;
function ts() {
  if (!tsModule) tsModule = require(require.resolve('typescript', { paths: [ROOT] }));
  return tsModule;
}

/** WORKSPACE_TABLES from the leaf module's text (a single `as const` array of quoted lower-case names). */
function loadTables(root = ROOT) {
  const src = fs.readFileSync(path.join(root, TABLES_FILE), 'utf8');
  const m = src.match(/export const WORKSPACE_TABLES = \[([\s\S]*?)\] as const;/);
  if (!m) throw new Error(`${TABLES_FILE}: WORKSPACE_TABLES array literal not found`);
  const tables = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  if (tables.length === 0 || new Set(tables).size !== tables.length) throw new Error(`${TABLES_FILE}: WORKSPACE_TABLES is empty or has duplicates`);
  return tables;
}

function patterns(tables) {
  // Longest first, so `shift` never shadows `shift_assignment` even before the look-ahead.
  const T = [...tables].sort((a, b) => b.length - a.length).join('|');
  const Q = '(?:"[^"\\n]*"|\\$\\{[^}]*\\}|"\\$\\{[^}]*\\}"|[A-Za-z_][\\w]*)';
  return {
    // keyword-anchored reference; group 2 = qualifier (with its dot), group 3 = table
    ref: new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE|ONLY)\\s+(${Q}\\s*\\.\\s*)?"?(${T})"?(?![\\w$."])`, 'g'),
    // any qualified reference anywhere (catches the second table of a comma list when it is qualified)
    qual: new RegExp(`(${Q})\\s*\\.\\s*"?(${T})"?(?![\\w$."(])`, 'g'),
    primitive: new RegExp(`^(?:t|tables)\\.(${T})$`),
    qbTable: new RegExp(`^(?:"?core"?\\.)?"?(${T})"?$`),
  };
}

const SQLISH = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|FROM|JOIN|TRUNCATE|MERGE)\b/;
// A runtime switch: set_config('search_path', …) or a statement that starts with SET [LOCAL|SESSION] search_path. Not the
// `SET search_path = …` attribute of CREATE FUNCTION / ALTER DATABASE / ALTER ROLE (DDL that pins a function's own path).
const SEARCH_PATH_SET_CONFIG = /set_config\(\s*'search_path'/i;
const SEARCH_PATH_STATEMENT = /(?:^|;)\s*SET\s+(?:LOCAL\s+|SESSION\s+)?search_path\b/im;
const DDL_WITH_PATH_ATTRIBUTE = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)|ALTER\s+(?:DATABASE|ROLE|USER|FUNCTION|PROCEDURE))\b/i;
const isSearchPathSwitch = (text) => SEARCH_PATH_SET_CONFIG.test(text) || (SEARCH_PATH_STATEMENT.test(text) && !DDL_WITH_PATH_ATTRIBUTE.test(text));
const QB_METHODS = new Set(['from', 'into', 'update', 'delete', 'leftJoin', 'leftJoinAndSelect', 'innerJoin', 'innerJoinAndSelect',
  'leftJoinAndMapOne', 'leftJoinAndMapMany', 'innerJoinAndMapOne', 'innerJoinAndMapMany']);
const MANAGER_METHODS = new Set(['find', 'findOne', 'findOneBy', 'findBy', 'findOneOrFail', 'findOneByOrFail', 'findAndCount', 'findAndCountBy',
  'save', 'insert', 'update', 'delete', 'count', 'countBy', 'exists', 'existsBy', 'increment', 'decrement', 'upsert', 'remove', 'softDelete',
  'softRemove', 'restore', 'createQueryBuilder', 'sum', 'max', 'min', 'average', 'clear', 'getRepository', 'preload']);

/** Workspace entity class names: @Entity classes mapped to a workspace table with no `schema` option. */
function workspaceEntities(files, tables) {
  const T = new Set(tables);
  const out = new Set();
  for (const { abs, src } of files) {
    if (!/@Entity\(/.test(src)) continue;
    const sf = ts().createSourceFile(abs, src, ts().ScriptTarget.Latest, true);
    sf.forEachChild((node) => {
      if (!ts().isClassDeclaration(node) || !node.name) return;
      for (const d of ts().getDecorators ? ts().getDecorators(node) ?? [] : node.decorators ?? []) {
        if (!ts().isCallExpression(d.expression) || d.expression.expression.getText(sf) !== 'Entity') continue;
        const [a0] = d.expression.arguments;
        let name = null;
        let schema = false;
        if (a0 && ts().isStringLiteral(a0)) name = a0.text;
        if (a0 && ts().isObjectLiteralExpression(a0)) {
          for (const p of a0.properties) {
            if (!ts().isPropertyAssignment(p)) continue;
            const key = p.name.getText(sf);
            if (key === 'name' && ts().isStringLiteral(p.initializer)) name = p.initializer.text;
            if (key === 'schema') schema = true;
          }
        }
        if (name && T.has(name) && !schema) out.add(node.name.text);
      }
    });
  }
  return out;
}

/** Every site in one file. `rel` is the repo-relative path (forward slashes). */
function scanSource(rel, src, tables, entities) {
  const t = ts();
  const P = patterns(tables);
  const sf = t.createSourceFile(rel, src, t.ScriptTarget.Latest, true);
  const sites = [];
  const handled = new Set();
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const binder = SEARCH_PATH_BINDERS.includes(rel);
  const add = (n, rule, detail) => sites.push({ file: rel, line: lineOf(n), rule, detail: detail.replace(/\s+/g, ' ').slice(0, 100) });

  const isStr = (n) => t.isStringLiteral(n) || t.isNoSubstitutionTemplateLiteral(n) || t.isTemplateExpression(n);
  const strValue = (n) => {
    if (t.isStringLiteral(n) || t.isNoSubstitutionTemplateLiteral(n)) return n.text;
    let s = n.head.text;
    for (const span of n.templateSpans) s += '${' + span.expression.getText(sf).trim() + '}' + span.literal.text;
    return s;
  };
  const flatten = (n) => {
    if (t.isBinaryExpression(n) && n.operatorToken.kind === t.SyntaxKind.PlusToken) return flatten(n.left) + flatten(n.right);
    if (t.isParenthesizedExpression(n)) return flatten(n.expression);
    return isStr(n) ? strValue(n) : '${' + n.getText(sf) + '}';
  };

  function recordSql(n, text) {
    if (!binder && isSearchPathSwitch(text)) add(n, 'search-path-switch', text);
    if (!SQLISH.test(text)) return;
    const seen = new Set();
    let m;
    P.ref.lastIndex = 0;
    while ((m = P.ref.exec(text))) {
      const qualifier = (m[2] || '').replace(/\s*\.\s*$/, '');
      seen.add(m.index + (m[0].length - m[0].replace(/^\S+\s+/, '').length));
      if (!qualifier) add(n, 'unqualified', `${m[1]} ${m[3]}`);
      else classifyQualified(n, qualifier, m[3]);
    }
    P.qual.lastIndex = 0;
    while ((m = P.qual.exec(text))) {
      if (seen.has(m.index)) continue;
      // Only explicit schema-like qualifiers here; `alias.column`-style text (`s.shift_id`) never matches a table name exactly.
      if (!/^(?:"[^"]*"|\$\{[^}]*\}|"\$\{[^}]*\}"|core|public)$/.test(m[1])) continue;
      classifyQualified(n, m[1], m[2]);
    }
  }
  function classifyQualified(n, qualifier, table) {
    if (/^"?core"?$/.test(qualifier)) add(n, 'core-qualified', `${qualifier}.${table}`);
    else add(n, 'other-qualified', `${qualifier}.${table}`);
  }

  function visit(n) {
    if (!handled.has(n)) {
      if (t.isBinaryExpression(n) && n.operatorToken.kind === t.SyntaxKind.PlusToken &&
          !(t.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === t.SyntaxKind.PlusToken)) {
        const parts = [];
        (function collect(x) {
          if (t.isBinaryExpression(x) && x.operatorToken.kind === t.SyntaxKind.PlusToken) { collect(x.left); collect(x.right); } else parts.push(x);
        })(n);
        if (parts.some(isStr)) { parts.forEach((p) => handled.add(p)); recordSql(n, flatten(n)); }
      } else if (t.isArrayLiteralExpression(n) && t.isPropertyAccessExpression(n.parent) && n.parent.name.text === 'join' && n.elements.some(isStr)) {
        n.elements.forEach((e) => handled.add(e));
        recordSql(n, n.elements.map((e) => (isStr(e) ? strValue(e) : '${' + e.getText(sf) + '}')).join(' '));
      } else if (isStr(n)) {
        recordSql(n, strValue(n));
      }
    }
    if (t.isCallExpression(n) && t.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const recv = n.expression.expression.getText(sf).replace(/\s+/g, '');
      const [a0] = n.arguments;
      if (a0 && QB_METHODS.has(method) && (t.isStringLiteral(a0) || t.isNoSubstitutionTemplateLiteral(a0)) && P.qbTable.test(a0.text)) {
        add(n, 'qb-string-table', `${method}('${a0.text}')`);
      }
      if (a0 && t.isIdentifier(a0) && entities.has(a0.text)) {
        if (method === 'getRepository') add(n, 'global-entity-access', `${recv}.getRepository(${a0.text})`);
        else if (MANAGER_METHODS.has(method) && /(?:^|\.)(?:dataSource|connection|DataSource)\.manager$/.test(recv)) add(n, 'global-entity-access', `${recv}.${method}(${a0.text})`);
      }
    }
    if (t.isDecorator(n) && t.isCallExpression(n.expression) && n.expression.expression.getText(sf) === 'InjectRepository') {
      const [a0] = n.expression.arguments;
      if (a0 && t.isIdentifier(a0) && entities.has(a0.text)) add(n, 'global-entity-access', `@InjectRepository(${a0.text})`);
    }
    t.forEachChild(n, visit);
  }
  visit(sf);
  return sites;
}

function listFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(p);
      } else if (entry.name.endsWith('.ts')) out.push(p);
    }
  };
  for (const d of SCAN) walk(path.join(root, d));
  return out.sort();
}

function scan(root = ROOT) {
  const tables = loadTables(root);
  const all = listFiles(root).map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), src: fs.readFileSync(abs, 'utf8') }));
  const entities = workspaceEntities(all, tables);
  const runtime = all.filter((f) => !EXCLUDE.some((re) => re.test(f.abs)));
  const sites = [];
  for (const f of runtime) sites.push(...scanSource(f.rel, f.src, tables, entities));
  return { sites, tables, entities };
}

/** { file: { rule: count } } with files and rules sorted, zero counts omitted. */
function countsOf(sites) {
  const out = {};
  for (const s of sites) ((out[s.file] ??= {})[s.rule] = (out[s.file]?.[s.rule] ?? 0) + 1);
  return sortCounts(out);
}
function sortCounts(counts) {
  const out = {};
  for (const file of Object.keys(counts).sort()) {
    const rules = {};
    for (const rule of RULES) if (counts[file][rule]) rules[rule] = counts[file][rule];
    for (const rule of Object.keys(counts[file]).sort()) if (!RULES.includes(rule) && counts[file][rule]) rules[rule] = counts[file][rule];
    if (Object.keys(rules).length) out[file] = rules;
  }
  return out;
}

/** The ratchet: `grown` = new sites (fail), `stale` = baseline above the current count (fail: lower it). */
function compare(current, baseline) {
  const grown = [];
  const stale = [];
  const unknownRules = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const cur = current[file] ?? {};
    const base = baseline[file] ?? {};
    for (const rule of new Set([...Object.keys(cur), ...Object.keys(base)])) {
      if (!RULES.includes(rule)) unknownRules.push({ file, rule });
      const c = cur[rule] ?? 0;
      const b = base[rule] ?? 0;
      if (!Number.isInteger(b) || b < 0) unknownRules.push({ file, rule });
      if (c > b) grown.push({ file, rule, current: c, baseline: b });
      else if (c < b) stale.push({ file, rule, current: c, baseline: b });
    }
  }
  return { grown, stale, unknownRules };
}

function readBaseline(file = BASELINE_FILE) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object') throw new Error(`${path.basename(file)}: expected { "files": { … } }`);
  return parsed.files;
}

function baselineDocument(counts) {
  return {
    _comment: [
      'Part C2 ratchet (tools/check-workspace-table-qualified.cjs). Per file and rule: the number of workspace-table references',
      'that are not yet schema-qualified through businessTables(manager). This file may only SHRINK: a module PR that qualifies',
      'sites lowers or deletes its rows in the same PR. Never raise a count; qualify the new reference instead. C2-7: empty.',
    ],
    files: counts,
  };
}

function main(argv) {
  const { sites } = scan();
  const current = countsOf(sites);
  if (argv.includes('--list')) {
    for (const s of sites) console.log(`${s.rule.padEnd(21)} ${s.file}:${s.line}  ${s.detail}`);
  }
  const baseline = readBaseline();
  if (argv.includes('--write-baseline')) {
    if (baseline) {
      const { grown } = compare(current, baseline);
      if (grown.length) {
        for (const g of grown) console.error(`REFUSED (would grow) ${g.rule} ${g.file}: ${g.baseline} -> ${g.current}`);
        console.error('[workspace-table-qualified] the baseline may only shrink: qualify the new references with businessTables(manager).');
        return 1;
      }
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselineDocument(current), null, 2) + '\n');
    console.log(`[workspace-table-qualified] baseline written: ${sites.length} site(s) in ${Object.keys(current).length} file(s).`);
    return 0;
  }
  if (!baseline) {
    console.error(`[workspace-table-qualified] ${path.relative(ROOT, BASELINE_FILE)} is missing.`);
    return 1;
  }
  const { grown, stale, unknownRules } = compare(current, baseline);
  for (const g of grown) {
    console.log(`NEW    ${g.rule.padEnd(21)} ${g.file}: ${g.current} site(s), baseline ${g.baseline}. Qualify it: const t = businessTables(manager); … \${t.<table>}`);
    for (const s of sites.filter((x) => x.file === g.file && x.rule === g.rule)) console.log(`         ${s.file}:${s.line}  ${s.detail}`);
  }
  for (const s of stale) console.log(`STALE  ${s.rule.padEnd(21)} ${s.file}: ${s.current} site(s), baseline ${s.baseline}. Lower the baseline entry (delete it at 0).`);
  for (const u of unknownRules) console.log(`BAD    baseline entry ${u.file} / ${u.rule}: unknown rule or not a non-negative integer.`);
  const baselineTotal = Object.values(baseline).reduce((n, rules) => n + Object.values(rules).reduce((a, b) => a + (Number(b) || 0), 0), 0);
  console.log(`[workspace-table-qualified] ${sites.length} unqualified site(s) (baseline ${baselineTotal}); ${grown.length} grown, ${stale.length} stale. (A static scan with stated limits: see the header.)`);
  return grown.length || stale.length || unknownRules.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { scan, scanSource, loadTables, workspaceEntities, countsOf, compare, baselineDocument, readBaseline, RULES, SEARCH_PATH_BINDERS };
