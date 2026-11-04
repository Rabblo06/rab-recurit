#!/usr/bin/env node
/**
 * Protected-table write check (owner decision 2026-11-04, BC-18 — "X2"): under the owner login the database no longer
 * refuses the runtime's direct writes to seven pre-auth tables that crewflow_app could only change through definers or a
 * few column grants. The owner accepted that, like Twenty, and asked for APP-LEVEL protection instead: every write to
 * these tables must stay inside the reviewed owning code. CI fails when a write appears anywhere else.
 *
 * Tables: login_handoff, organisation_invitation, released_host_label, user_auth_identity, user_session,
 * member_invitation, email_change_request.
 *
 * Flags, in production TypeScript under packages/rab-server/src and packages/rab-worker/src (specs, __tests__ and the
 * frozen core migrations excluded — migrations are reviewed and never edited after merge):
 *   sql-write   INSERT INTO / UPDATE / DELETE FROM / TRUNCATE [TABLE] / MERGE INTO / COPY … FROM naming one of the
 *               tables (schema-qualified or not, quoted or not, across line breaks) inside a string or template literal;
 *   orm-write   a write through TypeORM on an entity mapped to one of the tables (found from its @Entity name):
 *               manager.save/insert/update/delete/remove/softDelete/softRemove/upsert/restore(Entity, …),
 *               getRepository(Entity) / @InjectRepository(Entity) (a repository is write-capable), and query-builder
 *               .insert().into(Entity) / .update(Entity) / .delete().from(Entity).
 * A site passes only when its file is in ALLOWED below for that table. Comments are ignored.
 *
 *   node tools/check-protected-table-writes.cjs          # exit 1 on any write outside the allow-list
 *   node tools/check-protected-table-writes.cjs --list   # print every write site (for review)
 *
 * LIMITS: a text scan. SQL assembled at run time from pieces, a table name passed as a variable, or a write through a
 * SECURITY DEFINER defined elsewhere is not seen (definers live in reviewed migrations / *-sql.ts files, which ARE in the
 * allow-list where they write these tables). Reads are not checked.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['packages/rab-server/src', 'packages/rab-worker/src'];
const EXCLUDE = [/\.spec\.ts$/, /\.test\.ts$/, /[\\/]__tests__[\\/]/, /[\\/]database[\\/]typeorm[\\/]core[\\/]migrations[\\/]/, /[\\/]gated-migrations[\\/]/, /\.d\.ts$/];

const TABLES = Object.freeze([
  'login_handoff',
  'organisation_invitation',
  'released_host_label',
  'user_auth_identity',
  'user_session',
  'member_invitation',
  'email_change_request',
]);

/**
 * The reviewed owning code per file (path relative to the repo root) → tables it may write. Audit 2026-11-04 (Agent 3).
 * Adding an entry is a reviewed security change: say which service owns the write and why it cannot go through it.
 */
const ALLOWED = Object.freeze({
  // SECURITY DEFINER bodies (rab_secure_owner) — the only write path for these two tables.
  'packages/rab-server/src/database/typeorm/core/host-label-namespace-sql.ts': ['released_host_label'],
  'packages/rab-server/src/database/typeorm/core/login-handoff-sql.ts': ['login_handoff'],
  // Session lifecycle owners.
  'packages/rab-server/src/engine/core-modules/auth/token/services/refresh-token.service.ts': ['user_session'],
  'packages/rab-server/src/engine/core-modules/auth/services/session-validity.service.ts': ['user_session'],
  'packages/rab-server/src/engine/core-modules/auth/token/backfill/user-session-backfill.service.ts': ['user_session'],
  // Finding PTW-1 (LOW, audit 2026-11-04): three security revocations write user_session directly (revoked_at /
  // revoked_reason / security_version only, user-scoped, tenant-bound) instead of calling the session owner
  // (RefreshTokenService). Allow-listed so they stay visible; consolidation recommended.
  'packages/rab-server/src/engine/core-modules/auth/services/mfa-management.service.ts': ['user_session'],
  'packages/rab-server/src/engine/core-modules/platform-admin/admin-users.service.ts': ['user_session'],
  'packages/rab-server/src/engine/core-modules/platform-admin/privileged-grant-session-reset.ts': ['user_session'],
  // Single owning services.
  'packages/rab-server/src/engine/core-modules/auth/services/user-auth-identity.service.ts': ['user_auth_identity'],
  'packages/rab-server/src/modules/identity/services/email-change.service.ts': ['email_change_request'],
  'packages/rab-server/src/modules/membership/services/member-invitation.service.ts': ['member_invitation'],
});

const TABLE_RE = TABLES.join('|');
const SQL_WRITE = new RegExp(
  String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:"?core"?\s*\.\s*)?"?(${TABLE_RE})"?(?![\w])`,
  'gi',
);

/** Source with comments blanked (strings and templates kept; line numbers preserved). */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        i++;
      }
      out += src[i] ?? '';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(p, out);
    } else if (entry.name.endsWith('.ts') && !EXCLUDE.some((re) => re.test(p))) out.push(p);
  }
}

/** Entity classes mapped to protected tables: @Entity({ name: '<table>' … }) or @Entity('<table>') before `class X`. */
function protectedEntities(files) {
  const map = new Map();
  const re = new RegExp(String.raw`@Entity\(\s*(?:\{[^}]*name:\s*'(${TABLE_RE})'[^}]*\}|'(${TABLE_RE})')[^)]*\)\s*(?:@\w+\([^)]*\)\s*)*export\s+class\s+(\w+)`, 'g');
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) map.set(m[3], m[1] || m[2]);
  }
  return map;
}

function scanSource(rel, src, entities) {
  const text = stripComments(src);
  const sites = [];
  for (const m of text.matchAll(SQL_WRITE)) {
    sites.push({ file: rel, line: lineOf(text, m.index), rule: 'sql-write', table: m[2].toLowerCase(), what: m[0].replace(/\s+/g, ' ') });
  }
  for (const [cls, table] of entities) {
    const patterns = [
      new RegExp(String.raw`\.(save|insert|update|delete|remove|softDelete|softRemove|upsert|restore|increment|decrement)\(\s*${cls}\b`, 'g'),
      new RegExp(String.raw`\b(getRepository|InjectRepository|withRepository)\(\s*${cls}\b`, 'g'),
      // Query builder .insert().into(Entity) / .delete().from(Entity); .update(Entity) is covered by the first pattern.
      new RegExp(String.raw`\.(into|from)\(\s*${cls}\b`, 'g'),
    ];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) sites.push({ file: rel, line: lineOf(text, m.index), rule: 'orm-write', table, what: m[0] });
    }
  }
  return sites;
}

function scan(root = ROOT, allowed = ALLOWED) {
  const files = [];
  for (const d of SCAN) walk(path.join(root, d), files);
  const entities = protectedEntities(files);
  const sites = [];
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (const s of scanSource(rel, fs.readFileSync(file, 'utf8'), entities)) {
      sites.push({ ...s, allowed: (allowed[rel] ?? []).includes(s.table) });
    }
  }
  return { sites, entities };
}

if (require.main === module) {
  const { sites, entities } = scan();
  const bad = sites.filter((s) => !s.allowed);
  for (const s of process.argv.includes('--list') ? sites : bad) {
    console.log(`${s.allowed ? 'allowed   ' : 'NOT ALLOWED'} ${s.rule.padEnd(9)} ${s.table.padEnd(22)} ${s.file}:${s.line}  ${s.what}`);
  }
  console.log(
    `[protected-table-writes] ${sites.length} write site(s) to ${TABLES.length} protected tables (${entities.size} mapped entit${entities.size === 1 ? 'y' : 'ies'}); ` +
      `${bad.length} outside the reviewed owning code. (A text scan: see the header for its limits.)`,
  );
  process.exit(bad.length ? 1 : 0);
}

module.exports = { scan, scanSource, stripComments, TABLES, ALLOWED, protectedEntities };
