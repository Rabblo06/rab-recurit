import { Client } from 'pg';

/**
 * Database security posture: who owns every `core` object and what `crewflow` / `crewflow_app` may do with it.
 *
 * Why (CF-09, CF-41, CF-48): grant and ownership drift went unnoticed because tests ran on a long-lived database with
 * hand-applied grants. A database built only from migrations returned 503 on every cookie request. This module reads
 * the effective model (not the migration text) so a fresh build, an upgraded build and the golden snapshot can be
 * compared line by line.
 *
 * Read-only: a single READ ONLY transaction, catalog functions only.
 */
export const POSTURE_QUERY = `
SELECT line FROM (
  SELECT 'owner|table|' || c.relname || '|' || pg_get_userbyid(c.relowner) AS line
    FROM pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL
  SELECT 'owner|function|' || replace(p.oid::regprocedure::text, 'core.', '') || '|' || pg_get_userbyid(p.proowner) || '|definer=' || p.prosecdef
         || CASE WHEN p.prosecdef THEN '|' || coalesce((SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), 'search_path=<unset>') ELSE '' END
    FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace
  UNION ALL
  SELECT 'owner|schema|core|' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'core'
  UNION ALL
  SELECT 'rls|' || c.relname || '|enable=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'table|' || c.relname || '|' || r.rolname || '|' || concat_ws(',',
           CASE WHEN has_table_privilege(r.oid, c.oid, 'SELECT') THEN 'S' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'INSERT') THEN 'I' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'UPDATE') THEN 'U' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'DELETE') THEN 'D' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRUNCATE') THEN 'T' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'REFERENCES') THEN 'R' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRIGGER') THEN 'G' END)
    FROM pg_class c CROSS JOIN pg_roles r
   WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'S') AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'column|' || c.relname || '.' || a.attname || '|' || r.rolname || '|' || concat_ws(',',
           CASE WHEN has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT') THEN 'S' END,
           CASE WHEN has_column_privilege(r.oid, c.oid, a.attnum, 'INSERT') THEN 'I' END,
           CASE WHEN has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE') THEN 'U' END)
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped CROSS JOIN pg_roles r
   WHERE c.relnamespace = 'core'::regnamespace AND c.relname IN ('user', 'user_session', 'refresh_token') AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'execute|' || replace(p.oid::regprocedure::text, 'core.', '') || '|' || r.rolname || '|' || has_function_privilege(r.oid, p.oid, 'EXECUTE')
    FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace = 'core'::regnamespace AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'execute|' || replace(p.oid::regprocedure::text, 'core.', '') || '|PUBLIC|'
         || (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'))
    FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef
  UNION ALL
  SELECT 'schema|core|' || r.rolname || '|usage=' || has_schema_privilege(r.oid, 'core', 'USAGE') || '|create=' || has_schema_privilege(r.oid, 'core', 'CREATE')
    FROM pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'role|' || r.rolname || '|super=' || r.rolsuper || '|bypassrls=' || r.rolbypassrls || '|login=' || r.rolcanlogin
         || '|member_of=' || coalesce((SELECT string_agg(b.rolname, ',' ORDER BY b.rolname) FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid), '')
    FROM pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app', 'rab_secure_owner')
) posture
ORDER BY line`;

/**
 * F4 (Wave 1 lane S): the same facts for every physical workspace schema (`^workspace_[0-9a-f]{32}$`), which the core-only
 * query above never looked at. One row per (schema, line); `canonicalWorkspaceLines` replaces the schema name with
 * `workspace_*` and the workspace uuid with `<workspace_id>`, so every correctly built workspace yields the SAME lines —
 * the template expectation kept once in the golden snapshot (`ws|` lines), whatever the number of workspaces.
 *
 * Covered per schema: schema owner and ACL; every relation's owner (any relkind, so an injected view/sequence shows up);
 * ENABLE/FORCE RLS; every table's raw ACL (any grantee, PUBLIC included) and the effective privileges of crewflow /
 * crewflow_app; column ACLs; every policy (command, roles, USING, WITH CHECK); foreign keys with their delete action (F3);
 * the per-table workspace-binding CHECKs; triggers; any function placed in the schema.
 */
export const WORKSPACE_SCHEMA_PATTERN = '^workspace_[0-9a-f]{32}$';
export const WORKSPACE_LINE_PREFIX = 'ws|';

export const WORKSPACE_POSTURE_QUERY = `
WITH ws AS (SELECT oid, nspname FROM pg_namespace WHERE nspname ~ '${WORKSPACE_SCHEMA_PATTERN}'),
acl AS (
  SELECT x.oid, x.relname, x.relkind, x.relnamespace, a.grantee, a.privilege_type
    FROM (SELECT c.oid, c.relname, c.relowner, c.relkind, c.relnamespace, c.relacl FROM pg_class c JOIN ws ON ws.oid = c.relnamespace
           WHERE c.relkind <> 'i') x
    CROSS JOIN LATERAL aclexplode(coalesce(x.relacl, acldefault(CASE WHEN x.relkind = 'S' THEN 's' ELSE 'r' END::"char", x.relowner))) a
)
-- Policy expressions are pretty-printed over several lines: collapse whitespace so each fact is exactly one golden line.
SELECT schema, regexp_replace(line, '[[:space:]]+', ' ', 'g') AS line FROM (
  SELECT ws.nspname AS schema, 'ws|schema|owner|' || pg_get_userbyid(n.nspowner) AS line FROM ws JOIN pg_namespace n ON n.oid = ws.oid
  UNION ALL
  SELECT ws.nspname, 'ws|schema|acl|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END || '|'
         || string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
    FROM ws JOIN pg_namespace n ON n.oid = ws.oid CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
   GROUP BY ws.nspname, a.grantee
  UNION ALL
  SELECT ws.nspname, 'ws|schema|' || r.rolname || '|usage=' || has_schema_privilege(r.oid, ws.oid, 'USAGE') || '|create=' || has_schema_privilege(r.oid, ws.oid, 'CREATE')
    FROM ws CROSS JOIN pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT ws.nspname, 'ws|owner|' || c.relkind::text || '|' || c.relname || '|' || pg_get_userbyid(c.relowner)
    FROM ws JOIN pg_class c ON c.relnamespace = ws.oid
  UNION ALL
  SELECT ws.nspname, 'ws|rls|' || c.relname || '|enable=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
    FROM ws JOIN pg_class c ON c.relnamespace = ws.oid WHERE c.relkind IN ('r', 'p')
  UNION ALL
  SELECT ws.nspname, 'ws|acl|' || acl.relname || '|' || CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee)::text END || '|'
         || string_agg(acl.privilege_type, ',' ORDER BY acl.privilege_type)
    FROM ws JOIN acl ON acl.relnamespace = ws.oid
   GROUP BY ws.nspname, acl.relname, acl.grantee
  UNION ALL
  SELECT ws.nspname, 'ws|table|' || c.relname || '|' || r.rolname || '|' || concat_ws(',',
           CASE WHEN has_table_privilege(r.oid, c.oid, 'SELECT') THEN 'S' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'INSERT') THEN 'I' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'UPDATE') THEN 'U' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'DELETE') THEN 'D' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRUNCATE') THEN 'T' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'REFERENCES') THEN 'R' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRIGGER') THEN 'G' END)
    FROM ws JOIN pg_class c ON c.relnamespace = ws.oid CROSS JOIN pg_roles r
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT ws.nspname, 'ws|column|' || c.relname || '.' || at.attname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
         || '|' || string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
    FROM ws JOIN pg_class c ON c.relnamespace = ws.oid
    JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
    CROSS JOIN LATERAL aclexplode(at.attacl) a
   GROUP BY ws.nspname, c.relname, at.attname, a.grantee
  UNION ALL
  SELECT ws.nspname, 'ws|policy|' || p.tablename || '|' || p.policyname || '|' || p.permissive || '|' || p.roles::text || '|' || p.cmd
         || '|using=' || coalesce(p.qual, '<none>') || '|check=' || coalesce(p.with_check, '<none>')
    FROM ws JOIN pg_policies p ON p.schemaname = ws.nspname
  UNION ALL
  SELECT ws.nspname, 'ws|fk|' || c.relname || '|' || k.conname || '|' || pg_get_constraintdef(k.oid)
    FROM ws JOIN pg_constraint k ON k.connamespace = ws.oid JOIN pg_class c ON c.oid = k.conrelid WHERE k.contype = 'f'
  UNION ALL
  SELECT ws.nspname, 'ws|bound|' || c.relname || '|' || k.conname || '|' || pg_get_constraintdef(k.oid) || '|validated=' || k.convalidated
    FROM ws JOIN pg_constraint k ON k.connamespace = ws.oid JOIN pg_class c ON c.oid = k.conrelid
   WHERE k.contype = 'c' AND right(k.conname, 16) = '_workspace_bound'
  UNION ALL
  SELECT ws.nspname, 'ws|trigger|' || c.relname || '|' || t.tgname || '|enabled=' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
    FROM ws JOIN pg_class c ON c.relnamespace = ws.oid JOIN pg_trigger t ON t.tgrelid = c.oid WHERE NOT t.tgisinternal
  UNION ALL
  SELECT ws.nspname, 'ws|function|' || p.oid::regprocedure::text || '|' || pg_get_userbyid(p.proowner) || '|definer=' || p.prosecdef
    FROM ws JOIN pg_proc p ON p.pronamespace = ws.oid
) w`;

/** The workspace uuid a canonical schema name encodes (`workspace_<32 hex>` → 8-4-4-4-12). */
export function workspaceIdOfSchema(schema: string): string {
  const h = schema.slice('workspace_'.length);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Schema name → `workspace_*`, workspace uuid → `<workspace_id>`; sorted and de-duplicated. */
export function canonicalWorkspaceLines(schema: string, lines: string[]): string[] {
  const id = workspaceIdOfSchema(schema);
  return [...new Set(lines.map((l) => l.split(schema).join('workspace_*').split(id).join('<workspace_id>')))].sort();
}

export interface SecurityPosture {
  /** Core lines, exactly as before (POSTURE_QUERY). */
  core: string[];
  /** Canonical `ws|` lines per physical workspace schema, in schema-name order. */
  workspaces: Map<string, string[]>;
}

/** Core + every workspace schema, read in ONE read-only transaction (a consistent snapshot). */
export async function readFullSecurityPosture(connectionString: string): Promise<SecurityPosture> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const core = (await client.query<{ line: string }>(POSTURE_QUERY)).rows.map((r) => r.line);
    const raw = (await client.query<{ schema: string; line: string }>(WORKSPACE_POSTURE_QUERY)).rows;
    await client.query('ROLLBACK');
    const bySchema = new Map<string, string[]>();
    for (const r of raw) bySchema.set(r.schema, [...(bySchema.get(r.schema) ?? []), r.line]);
    const workspaces = new Map<string, string[]>();
    for (const schema of [...bySchema.keys()].sort()) workspaces.set(schema, canonicalWorkspaceLines(schema, bySchema.get(schema)!));
    return { core, workspaces };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Splits a golden snapshot into its core lines and its workspace-template (`ws|`) lines. */
export function splitGolden(lines: string[]): { core: string[]; workspace: string[] } {
  return {
    core: lines.filter((l) => !l.startsWith(WORKSPACE_LINE_PREFIX)),
    workspace: lines.filter((l) => l.startsWith(WORKSPACE_LINE_PREFIX)),
  };
}

export interface WorkspacePostureDrift {
  schema: string;
  missing: string[];
  unexpected: string[];
}

/**
 * Every workspace schema compared, ON ITS OWN, with the template expectation. A schema that lost FORCE, a policy or its
 * RESTRICT FKs, gained a grant or changed owner shows up here by name — a union over all schemas would hide a line missing
 * from only one of them. Zero schemas is not drift (a fresh install has none).
 */
export function diffWorkspacePosture(expected: string[], workspaces: Map<string, string[]>): WorkspacePostureDrift[] {
  const drifts: WorkspacePostureDrift[] = [];
  for (const [schema, lines] of workspaces) {
    const d = diffPosture(expected, lines);
    if (d.missing.length || d.unexpected.length) drifts.push({ schema, ...d });
  }
  return drifts;
}

/** Core lines + workspace drift against a golden snapshot, in one call (what the CLI and the integration test use). */
export async function compareWithGolden(
  connectionString: string,
  golden: string[],
): Promise<{ core: { missing: string[]; unexpected: string[] }; workspaces: WorkspacePostureDrift[]; workspaceCount: number; lines: number }> {
  const expected = splitGolden(golden);
  const posture = await readFullSecurityPosture(connectionString);
  return {
    core: diffPosture(expected.core, posture.core),
    workspaces: diffWorkspacePosture(expected.workspace, posture.workspaces),
    workspaceCount: posture.workspaces.size,
    lines: posture.core.length + expected.workspace.length,
  };
}

/**
 * The lines a `--write` stores: the core lines, then the ONE canonical workspace fingerprint. Refuses when workspace schemas
 * disagree (it never picks one as "the template"); with no workspace schema it keeps the previous golden's `ws|` section.
 */
export function goldenLinesFrom(posture: SecurityPosture, previousWorkspaceLines: string[]): { lines: string[]; workspaceSource: string } {
  const distinct = new Map<string, string[]>();
  for (const [schema, lines] of posture.workspaces) {
    const key = lines.join('\n');
    distinct.set(key, [...(distinct.get(key) ?? []), schema]);
  }
  if (distinct.size > 1) {
    const groups = [...distinct.values()].map((schemas) => `${schemas.length} schema(s), e.g. ${schemas[0]}`).join('; ');
    throw new Error(`workspace schemas disagree (${distinct.size} distinct fingerprints: ${groups}); refusing to pick one as the template`);
  }
  if (distinct.size === 0) {
    return { lines: [...posture.core, ...previousWorkspaceLines], workspaceSource: 'kept from the previous golden (no workspace schema present)' };
  }
  const [only] = posture.workspaces.values();
  return { lines: [...posture.core, ...only!], workspaceSource: `${posture.workspaces.size} identical workspace schema(s)` };
}

export async function readSecurityPosture(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query<{ line: string }>(POSTURE_QUERY);
    await client.query('ROLLBACK');
    return rows.map((r) => r.line);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Lines present on one side only. Empty means the posture matches exactly. */
export function diffPosture(expected: string[], actual: string[]): { missing: string[]; unexpected: string[] } {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: expected.filter((l) => !have.has(l)),
    unexpected: actual.filter((l) => !want.has(l)),
  };
}
