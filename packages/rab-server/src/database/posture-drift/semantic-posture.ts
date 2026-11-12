// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
import { createHash } from 'node:crypto';

/**
 * SEMANTIC POSTURE (M0 §6.4 control 4; G-02 "the integrity gate is blind to policy and function rewrites that keep FORCE
 * on"). The owner login can rewrite any security object; the FORCE / ownership checks only see flags. This module reads a
 * CANONICAL, line-per-fact form of everything that decides who sees what, hashes it, and compares it with
 *   (a) the committed golden for the server's major version (security-semantic.pg<major>.golden.txt, generated from a
 *       database built from migrations alone with the owner-login bootstrap) — the object section, at boot;
 *   (b) the snapshot taken at boot — every section, on the monitor's timer (a change while the process runs).
 *
 * Sections (each line `section|…`, sorted, de-duplicated):
 *   policy    every core policy: table, name, PERMISSIVE/RESTRICTIVE, roles, command, md5 of USING and WITH CHECK
 *             (whitespace-normalised pg_get_expr text) — ALTER POLICY … USING (true) changes the hash, FORCE does not hide it;
 *   function  every core function (extension members excluded): signature, owner, SECURITY DEFINER, language, volatility,
 *             strictness, leakproof, proconfig (search_path), md5 of the body — a trojaned definer changes the hash;
 *   trigger   every non-internal core trigger: table, name, enabled state (O/D/R/A), function — DISABLE TRIGGER shows;
 *   rls       ENABLE / FORCE per core table;
 *   acl       the full raw ACL of core.audit_log (table and columns, grantee:privilege:grantable) — a re-grant of
 *             UPDATE/DELETE/TRUNCATE shows;
 *   owner     owner of every core relation and of the core schema;
 *   ws        the same policy / trigger / rls / owner facts for every workspace schema, canonicalised (schema name →
 *             workspace_*), compared per schema;
 *   setting   any stored role / database setting (pg_db_role_setting) for this database or all databases — e.g. an
 *             `ALTER ROLE crewflow_owner SET row_security = off` or a planted search_path;
 *   role / member (ROLE section, boot snapshot only — the exact layout is judged by the owner-login inventory rules, since
 *             grantor and creator rows differ between a fresh install and an upgraded database): attributes of the layout
 *             roles and the login, and every membership row among them (grant options, never the grantor).
 *
 * READ ONLY: one READ ONLY transaction, catalog functions only. It never rewrites, re-grants or "repairs" anything —
 * drift refuses readiness (boot) or raises an alert (monitor); a human restores the reviewed posture.
 * Limits (stated, not hidden): it is a point-in-time comparison. A rewrite that is made and undone between two checks is
 * not seen (the external audit sink and pgaudit / provider logs are the record for that); objects outside the
 * sections above (e.g. extension internals, other schemas) are not hashed; md5 here is a change detector over catalog text,
 * not a security boundary (the attacker who can rewrite policies can also read this code).
 */

const LAYOUT = ['crewflow_owner', 'rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow', 'crewflow_app', 'crewflow_worker'];
const layoutList = LAYOUT.map((r) => `'${r}'`).join(', ');
const WS = `'^workspace_[0-9a-f]{32}$'`;
/**
 * Settings excluded from the semantic posture by EXACT name (never a `crewflow.*` wildcard): the disposable-test marker
 * (test-database-guard.ts DISPOSABLE_TEST_DATABASE_SETTING). It is set on CI's throwaway databases only; a production
 * process on a marked database is refused by assertDeploymentIdentity, so excluding it here hides nothing.
 */
export const POSTURE_EXCLUDED_SETTING = 'crewflow.disposable_test_database';

/** Object section: compared with the committed golden. Rows: (schema, line); schema = 'core' or a workspace schema. */
export const SEMANTIC_OBJECT_SQL = `
WITH ext AS (SELECT d.objid FROM pg_catalog.pg_depend d WHERE d.deptype = 'e'),
ws AS (SELECT n.oid, n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname ~ ${WS}),
sch AS (SELECT 'core'::regnamespace::oid AS oid, 'core'::text AS nspname UNION ALL SELECT oid, nspname::text FROM ws)
SELECT schema, line FROM (
  SELECT s.nspname AS schema,
         'policy|' || c.relname || '|' || p.polname || '|' || CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END
         || '|' || coalesce((SELECT pg_catalog.string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(x)::text END, ',' ORDER BY 1)
                             FROM pg_catalog.unnest(p.polroles) x), '')
         || '|' || p.polcmd::text
         || '|using=' || coalesce(pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')), '-')
         || '|check=' || coalesce(pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g')), '-') AS line
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN sch s ON s.oid = c.relnamespace
  UNION ALL
  SELECT 'core',
         'function|' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
         || '|owner=' || pg_catalog.pg_get_userbyid(p.proowner) || '|definer=' || p.prosecdef || '|lang=' || l.lanname
         || '|vol=' || p.provolatile::text || '|strict=' || p.proisstrict || '|leakproof=' || p.proleakproof
         || '|config=' || coalesce(pg_catalog.array_to_string(p.proconfig, ';'), '-')
         || '|body=' || pg_catalog.md5(coalesce(p.prosrc, '') || '|' || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), ''))
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'core'::regnamespace AND p.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT s.nspname, 'trigger|' || c.relname || '|' || t.tgname || '|enabled=' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN sch s ON s.oid = c.relnamespace
   WHERE NOT t.tgisinternal
  UNION ALL
  SELECT s.nspname, 'rls|' || c.relname || '|enable=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN sch s ON s.oid = c.relnamespace WHERE c.relkind IN ('r', 'p')
  UNION ALL
  SELECT s.nspname, 'owner|' || c.relkind::text || '|' || c.relname || '|' || pg_catalog.pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c JOIN sch s ON s.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT s.nspname, 'owner|schema|' || s.nspname || '|' || pg_catalog.pg_get_userbyid(n.nspowner)
    FROM sch s JOIN pg_catalog.pg_namespace n ON n.oid = s.oid
  UNION ALL
  SELECT 'core', 'acl|audit_log|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
         || ':' || a.privilege_type || ':' || a.is_grantable
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
   WHERE c.oid = 'core.audit_log'::regclass
  UNION ALL
  SELECT 'core', 'acl|audit_log.' || at.attname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
         || ':' || a.privilege_type
    FROM pg_catalog.pg_attribute at CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a
   WHERE at.attrelid = 'core.audit_log'::regclass AND at.attacl IS NOT NULL
  UNION ALL
  SELECT 'core', 'setting|' || CASE WHEN s.setrole = 0 THEN '*' ELSE coalesce(pg_catalog.pg_get_userbyid(s.setrole)::text, '?') END
         || '|' || CASE WHEN s.setdatabase = 0 THEN '*' ELSE 'this' END || '|' || c.cfg
    FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS c(cfg)
   WHERE s.setdatabase IN (0, (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))
     -- Excluded by EXACT name (whatever its value): the disposable-test marker is a property of CI's throwaway databases,
     -- not of the security posture, and it made every real database differ from goldens captured in CI (hotfix
     -- fix/posture-test-marker). Production on a marked database is refused by the identity gate instead.
     AND pg_catalog.split_part(c.cfg, '=', 1) <> '${POSTURE_EXCLUDED_SETTING}'
) facts`;

/** Role section: compared with the boot snapshot (the exact layout is judged by owner-login-posture.ts). */
export const SEMANTIC_ROLE_SQL = `
SELECT line FROM (
  SELECT 'role|' || r.rolname || '|login=' || r.rolcanlogin || '|super=' || r.rolsuper || '|bypassrls=' || r.rolbypassrls
         || '|createrole=' || r.rolcreaterole || '|createdb=' || r.rolcreatedb || '|replication=' || r.rolreplication
         || '|inherit=' || r.rolinherit || '|validuntil=' || coalesce(r.rolvaliduntil::text, '-') AS line
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${layoutList})
  UNION ALL
  SELECT 'member|' || r.rolname || '|' || m.rolname || '|admin=' || a.admin_option || '|inherit=' || a.inherit_option || '|set=' || a.set_option
    FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid = a.roleid JOIN pg_catalog.pg_roles m ON m.oid = a.member
   WHERE r.rolname IN (${layoutList}) OR m.rolname IN (${layoutList})
  UNION ALL
  SELECT 'login-count|' || pg_catalog.count(*) FROM pg_catalog.pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper
) roles`;

export const WORKSPACE_PLACEHOLDER = 'workspace_*';

export type SemanticQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export interface SemanticPosture {
  /** Canonical core object lines (sorted). */
  core: string[];
  /** Canonical object lines per workspace schema (schema name replaced by workspace_*). */
  workspaces: Map<string, string[]>;
  /** Role / membership lines (sorted). */
  roles: string[];
  /** sha256 over core + every workspace (in name order) + roles: one value to log and compare. */
  sha256: string;
  serverMajor: number;
}

const sortedUnique = (lines: string[]) => [...new Set(lines)].sort();

/**
 * Reads the semantic posture over `query` inside ONE read-only transaction (the caller's session). `ownTransaction: false`
 * reads inside the caller's open transaction instead (tests that plant a change and roll it back).
 */
export async function readSemanticPosture(query: SemanticQuery, options: { ownTransaction?: boolean } = {}): Promise<SemanticPosture> {
  const own = options.ownTransaction !== false;
  if (own) await query('BEGIN READ ONLY');
  try {
    const [{ v }] = (await query(`SELECT pg_catalog.current_setting('server_version_num')::int AS v`)) as Array<{ v: number }>;
    const objects = await query(SEMANTIC_OBJECT_SQL);
    const roles = sortedUnique((await query(SEMANTIC_ROLE_SQL)).map((r) => String(r.line)));
    const core: string[] = [];
    const bySchema = new Map<string, string[]>();
    for (const r of objects) {
      const schema = String(r.schema);
      const line = String(r.line);
      if (schema === 'core') core.push(line);
      else bySchema.set(schema, [...(bySchema.get(schema) ?? []), line.split(schema).join(WORKSPACE_PLACEHOLDER)]);
    }
    const workspaces = new Map<string, string[]>();
    for (const schema of [...bySchema.keys()].sort()) workspaces.set(schema, sortedUnique(bySchema.get(schema)!));
    const coreLines = sortedUnique(core);
    const hash = createHash('sha256');
    hash.update(coreLines.join('\n'));
    for (const [schema, lines] of workspaces) hash.update(`\n#${schema}\n${lines.join('\n')}`);
    hash.update(`\n#roles\n${roles.join('\n')}`);
    return { core: coreLines, workspaces, roles, sha256: hash.digest('hex'), serverMajor: Math.floor(Number(v) / 10000) };
  } finally {
    if (own) await query('ROLLBACK').catch(() => undefined);
  }
}

export interface SemanticDrift {
  section: string;
  missing: string[];
  unexpected: string[];
}

function diff(section: string, expected: readonly string[], actual: readonly string[]): SemanticDrift | null {
  const want = new Set(expected);
  const have = new Set(actual);
  const missing = expected.filter((l) => !have.has(l));
  const unexpected = actual.filter((l) => !want.has(l));
  return missing.length || unexpected.length ? { section, missing, unexpected } : null;
}

/** Golden file lines: core lines, then `ws|`-prefixed workspace-template lines. */
export function splitSemanticGolden(lines: readonly string[]): { core: string[]; workspace: string[] } {
  return {
    core: lines.filter((l) => !l.startsWith('ws|')),
    workspace: lines.filter((l) => l.startsWith('ws|')).map((l) => l.slice(3)),
  };
}

/** Lines a --write stores: core, then ONE workspace template (refuses when workspace schemas disagree). */
export function semanticGoldenLines(posture: SemanticPosture, previousWorkspace: readonly string[]): string[] {
  const distinct = new Set([...posture.workspaces.values()].map((l) => l.join('\n')));
  if (distinct.size > 1) throw new Error(`workspace schemas disagree (${distinct.size} distinct semantic fingerprints); refusing to pick one as the template`);
  const ws = distinct.size === 1 ? [...posture.workspaces.values()][0]! : [...previousWorkspace];
  return [...posture.core, ...ws.map((l) => `ws|${l}`)];
}

/** Object drift against the committed golden: core, and every workspace schema ON ITS OWN against the template. */
export function semanticDriftFromGolden(posture: SemanticPosture, golden: readonly string[]): SemanticDrift[] {
  const g = splitSemanticGolden(golden);
  const out: SemanticDrift[] = [];
  const core = diff('core', g.core, posture.core);
  if (core) out.push(core);
  // No workspace template in the golden (it was generated from a database with no workspace schema): workspaces are not
  // compared here (the caller warns); the posture golden's ws| lines, check-rls-coverage and the fingerprints cover them.
  if (g.workspace.length === 0) return out;
  for (const [schema, lines] of posture.workspaces) {
    const d = diff(schema, g.workspace, lines);
    if (d) out.push(d);
  }
  return out;
}

/** Drift of every section against a previous snapshot (the monitor's runtime check). */
export function semanticDriftFromSnapshot(baseline: SemanticPosture, now: SemanticPosture): SemanticDrift[] {
  const out: SemanticDrift[] = [];
  const core = diff('core', baseline.core, now.core);
  if (core) out.push(core);
  const schemas = new Set([...baseline.workspaces.keys(), ...now.workspaces.keys()]);
  for (const schema of [...schemas].sort()) {
    // A workspace provisioned after boot is not drift (it is checked against the golden template instead).
    if (!baseline.workspaces.has(schema)) continue;
    const d = diff(schema, baseline.workspaces.get(schema)!, now.workspaces.get(schema) ?? []);
    if (d) out.push(d);
  }
  const roles = diff('roles', baseline.roles, now.roles);
  if (roles) out.push(roles);
  return out;
}

/** One sanitised line per drift (no row data: catalog names and hashes only). */
export function describeSemanticDrift(drifts: readonly SemanticDrift[], limit = 20): string {
  const parts: string[] = [];
  for (const d of drifts) {
    for (const l of d.missing) parts.push(`[${d.section}] - ${l}`);
    for (const l of d.unexpected) parts.push(`[${d.section}] + ${l}`);
  }
  const shown = parts.slice(0, limit);
  return shown.join('; ') + (parts.length > limit ? `; … ${parts.length - limit} more` : '');
}
