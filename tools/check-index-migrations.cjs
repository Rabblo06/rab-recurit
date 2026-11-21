#!/usr/bin/env node
/**
 * Index migration rules (index-fix tooling 2 and 3, docs/plans/index-fix/CREWFLOW_INDEX_FIX_PROMPT.md "Tooling"), for every
 * core migration NEWER than BASELINE_TIMESTAMP (the newest migration on main when the rule landed; older migrations are
 * frozen and never edited, so they are not re-judged):
 *
 *   concurrently   a CREATE INDEX on a table the same migration does not create must be CREATE INDEX CONCURRENTLY (or the
 *                  repository's `${cc}` switch, an interpolation right after INDEX that is 'CONCURRENTLY ' unless TypeORM
 *                  forced a transaction), and the migration must declare `transaction = false`. A plain CREATE INDEX takes a
 *                  SHARE lock that blocks every write to the table for the whole build. Exemption, for a reviewed reason
 *                  only (e.g. a table that is provably tiny): `// index-migration-reviewed: <reason of 20+ characters>` on
 *                  the line of the string or the line directly above it.
 *   transaction    CONCURRENTLY written out literally without `transaction = false` (it cannot run inside a transaction).
 *   name           every index has an explicit name; a literal name ends in _idx/_key/_pkey/_uq/_uniq/_unique/_uidx/_excl
 *                  and is at most 63 bytes (PostgreSQL truncates a longer name silently, so a later DROP by the full name
 *                  misses). An interpolated name cannot be read here; the catalogue check (check-index-hygiene.ts, in the
 *                  rls-coverage job) judges the built name.
 *
 * Reads the TypeScript AST (the repository's `typescript`): only string and template literal text is scanned, so comments
 * that mention CREATE INDEX do not count; `${...}` becomes a placeholder. LIMITS (stated): SQL assembled across variables
 * or functions, TypeORM's `createIndex(new TableIndex(...))` API (no migration here uses it) and a table created under a
 * different spelling are not understood; the catalogue check and review cover them.
 *
 *   node tools/check-index-migrations.cjs          # exit 1 on a finding
 *   node tools/check-index-migrations.cjs --all    # also report the frozen migrations (information only, exit 0)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_DIRS = ['packages/rab-server/src/database/typeorm/core/migrations', 'packages/rab-server/src/database/typeorm/core/gated-migrations'];
/** The newest core migration on main when the rule landed (1786721570000-MetadataVersionBumpOwnTransaction). */
const BASELINE_TIMESTAMP = 1786721570000;
const NAME_SUFFIX = /_(idx|key|pkey|uq|uniq|unique|uidx|excl)$/;
const MAX_NAME_BYTES = 63;
const PLACEHOLDER = '\u0000';
const REVIEWED = /\/\/\s*index-migration-reviewed:\s*(.{20,})$/;

function loadTypeScript(root = ROOT) {
  try {
    return require(require.resolve('typescript', { paths: [root] }));
  } catch {
    return null;
  }
}

/** Every string / template literal of a source file: its text (interpolations as PLACEHOLDER) and its start line (1-based). */
function literalsOf(ts, fileName, src) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    } else if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join('');
      out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const transactionFalse = /\btransaction\s*(?::\s*boolean\s*)?=\s*false\b/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  return { literals: out, transactionFalse };
}

const IDENT = `(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*|${PLACEHOLDER})+`;
const QUALIFIED = `${IDENT}(?:\\.${IDENT})?`;
/** The statement head: CREATE [UNIQUE] INDEX, then CONCURRENTLY or the `${cc}` switch (an interpolation right after INDEX). */
const CREATE_INDEX_HEAD = new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\b(\\s+CONCURRENTLY\\b|\\s*${PLACEHOLDER})?`, 'gi');
/** The rest, when it is written out: [IF NOT EXISTS] [name] ON [ONLY] table. */
const CREATE_INDEX_REST = new RegExp(`^\\s*(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(${QUALIFIED})\\s+)?ON\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'i');
const CREATE_TABLE = new RegExp(`\\bCREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, 'gi');

function normaliseTable(t) {
  return t.replace(/"/g, '').toLowerCase();
}

function shown(text) {
  return text.split(PLACEHOLDER).join('${…}');
}

/**
 * Findings for one migration source. Each: { line, rule, message }. When the name and table are interpolated (the
 * `CREATE INDEX ${cc}IF NOT EXISTS ${name} ${definition}` idiom), the table is treated as an existing one (fail closed) and
 * the name is left to the catalogue check.
 */
function analyseMigration(ts, fileName, src) {
  const { literals, transactionFalse } = literalsOf(ts, fileName, src);
  const lines = src.split(/\r?\n/);
  const created = new Set();
  for (const lit of literals) for (const m of lit.text.matchAll(CREATE_TABLE)) created.add(normaliseTable(m[1]));
  const findings = [];
  for (const lit of literals) {
    for (const head of lit.text.matchAll(CREATE_INDEX_HEAD)) {
      const token = head[1] ?? '';
      const rest = CREATE_INDEX_REST.exec(lit.text.slice(head.index + head[0].length));
      const name = rest ? rest[1] : PLACEHOLDER;
      const table = rest ? rest[2] : null;
      const line = lit.line + lit.text.slice(0, head.index).split('\n').length - 1;
      const reviewed = [lines[lit.line - 1], lines[lit.line - 2], lines[line - 1], lines[line - 2]].some((l) => l !== undefined && REVIEWED.test(l.trim()));
      const literalConcurrently = /CONCURRENTLY/i.test(token);
      const switchConcurrently = token.includes(PLACEHOLDER);
      const newTable = table !== null && created.has(normaliseTable(table));
      if (!newTable && !reviewed) {
        if (!literalConcurrently && !switchConcurrently) {
          findings.push({ line, rule: 'concurrently', message: `CREATE INDEX on existing table ${table ? shown(table) : '(interpolated)'} without CONCURRENTLY (a SHARE lock blocks writes for the whole build)` });
        } else if (!transactionFalse) {
          findings.push({ line, rule: 'concurrently', message: 'CREATE INDEX CONCURRENTLY needs `transaction = false` on the migration class' });
        }
      } else if (literalConcurrently && !transactionFalse) {
        findings.push({ line, rule: 'transaction', message: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction: declare `transaction = false`' });
      }
      if (!name) {
        findings.push({ line, rule: 'name', message: 'unnamed index: name it explicitly (<table>_<columns>_idx)' });
      } else if (!name.includes(PLACEHOLDER)) {
        const bare = name.split('.').pop().replace(/"/g, '');
        if (!NAME_SUFFIX.test(bare)) findings.push({ line, rule: 'name', message: `index name ${bare} must end in _idx, _key, _pkey, _uq, _uniq, _unique, _uidx or _excl` });
        if (Buffer.byteLength(bare, 'utf8') > MAX_NAME_BYTES) findings.push({ line, rule: 'name', message: `index name ${bare} is ${Buffer.byteLength(bare, 'utf8')} bytes; PostgreSQL truncates names to ${MAX_NAME_BYTES}` });
      }
    }
  }
  return findings;
}

function timestampOf(file) {
  const m = /^(\d{13})-/.exec(path.basename(file));
  return m ? Number(m[1]) : null;
}

function migrationFiles(root = ROOT) {
  const files = [];
  for (const dir of MIGRATION_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) if (/\.ts$/.test(f) && !/\.spec\.ts$/.test(f)) files.push(path.posix.join(dir, f));
  }
  return files;
}

function main(argv = process.argv.slice(2), root = ROOT) {
  const ts = loadTypeScript(root);
  if (!ts) {
    console.error('check-index-migrations: the repository typescript package could not be loaded (run yarn install); refusing to pass');
    return 1;
  }
  const all = argv.includes('--all');
  let failing = 0;
  let checked = 0;
  for (const rel of migrationFiles(root)) {
    const ts13 = timestampOf(rel);
    if (ts13 === null) {
      console.error(`${rel}: no 13-digit timestamp prefix; refusing to guess whether the rule applies`);
      failing += 1;
      continue;
    }
    const frozen = ts13 <= BASELINE_TIMESTAMP;
    if (frozen && !all) continue;
    checked += 1;
    for (const f of analyseMigration(ts, rel, fs.readFileSync(path.join(root, rel), 'utf8'))) {
      console[frozen ? 'log' : 'error'](`${rel}:${f.line} [${f.rule}]${frozen ? ' (frozen, information only)' : ''} ${f.message}`);
      if (!frozen) failing += 1;
    }
  }
  if (failing > 0) {
    console.error(`check-index-migrations: ${failing} finding(s) in migrations newer than ${BASELINE_TIMESTAMP}`);
    return 1;
  }
  console.log(`check-index-migrations: OK (${checked} migration(s) checked; ${all ? 'frozen ones reported for information' : `frozen up to ${BASELINE_TIMESTAMP}`})`);
  return 0;
}

module.exports = { analyseMigration, literalsOf, loadTypeScript, main, migrationFiles, BASELINE_TIMESTAMP, PLACEHOLDER };

if (require.main === module) process.exitCode = main();
