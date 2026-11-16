import type { Client } from 'pg';

/**
 * Metadata engine M1 / E2 (owner's M1 exit criterion "metadata for every workspace matches the 21 tables"): compares ONE
 * workspace's standard metadata with that workspace's real tables in pg_catalog, independently of the code's definitions
 * (only the PostgreSQL type → field type map below is assumed, from M0-STANDARD-OBJECTS.md §1). Read through the disposable
 * cluster's superuser (no RLS), so rows of the wrong organisation would be seen. Returns the differences (empty = equal).
 */
const TENANT = new Set(['organisation_id', 'workspace_id']);
const CORE_REFERENCE_TABLES: Record<string, string> = { user: 'user', stored_file: 'stored_file', manager_profile: 'manager_profile', payroll_calendar_period: 'payroll_calendar_period' };

export function fieldTypesFor(pgType: string): string[] {
  if (pgType === 'uuid') return ['UUID', 'RELATION'];
  if (pgType === 'text') return ['TEXT', 'SELECT'];
  if (/^(integer|smallint|bigint)$/.test(pgType)) return ['NUMBER'];
  if (pgType.startsWith('numeric')) return ['NUMERIC'];
  const fixed: Record<string, string> = { boolean: 'BOOLEAN', date: 'DATE', 'timestamp with time zone': 'DATE_TIME', jsonb: 'RAW_JSON', 'text[]': 'ARRAY', tsvector: 'TS_VECTOR', tstzrange: 'RANGE' };
  return fixed[pgType] ? [fixed[pgType]!] : [];
}

export interface WorkspaceRef {
  id: string;
  org: string;
  schema: string;
}

export async function metadataCatalogDifferences(admin: Client, ws: WorkspaceRef, workspaceTables: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const cols = (
    await admin.query(
      `SELECT c.relname::text AS t, a.attname::text AS c, format_type(a.atttypid, a.atttypmod) AS ty, a.attnotnull AS nn
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
      [ws.schema],
    )
  ).rows as Array<{ t: string; c: string; ty: string; nn: boolean }>;
  const fks = (
    await admin.query(
      `SELECT c.relname::text AS t, k.conname::text AS name, r.relname::text AS target, rn.nspname::text AS target_schema,
              ARRAY(SELECT a.attname::text FROM unnest(k.conkey) x JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x) AS cols,
              ARRAY(SELECT a.attname::text FROM unnest(k.confkey) x JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x) AS tcols
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class r ON r.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
        WHERE c.relnamespace = $1::regnamespace AND k.contype = 'f'`,
      [ws.schema],
    )
  ).rows as Array<{ t: string; name: string; target: string; target_schema: string; cols: string[]; tcols: string[] }>;
  const checks = (
    await admin.query(
      `SELECT c.relname::text AS t, k.conname::text AS name, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = $1::regnamespace`,
      [ws.schema],
    )
  ).rows as Array<{ t: string; name: string; def: string }>;
  const objects = (
    await admin.query(`SELECT id::text, organisation_id::text AS org, physical_table, is_custom, is_system FROM core.object_metadata WHERE workspace_id = $1`, [ws.id])
  ).rows as Array<{ id: string; org: string; physical_table: string; is_custom: boolean; is_system: boolean }>;
  const fields = (
    await admin.query(
      `SELECT id::text, organisation_id::text AS org, object_metadata_id::text AS object, name, type, physical_column, is_nullable, is_custom, settings,
              relation_target_object_metadata_id::text AS target_object, relation_target_field_metadata_id::text AS target_field
         FROM core.field_metadata WHERE workspace_id = $1`,
      [ws.id],
    )
  ).rows as Array<{ id: string; org: string; object: string; name: string; type: string; physical_column: string | null; is_nullable: boolean; is_custom: boolean; settings: Record<string, unknown> | null; target_object: string | null; target_field: string | null }>;
  const options = (await admin.query(`SELECT field_metadata_id::text AS field, organisation_id::text AS org, value FROM core.field_metadata_option WHERE workspace_id = $1`, [ws.id]))
    .rows as Array<{ field: string; org: string; value: string }>;

  for (const r of [...objects, ...fields, ...options]) if (r.org !== ws.org) out.push(`a metadata row of another organisation in workspace ${ws.id}`);
  const standard = objects.filter((o) => !o.is_custom);
  const objectByTable = new Map(standard.map((o) => [o.physical_table, o]));
  const tablesInSchema = [...new Set(cols.map((c) => c.t))].filter((t) => !t.startsWith('c_')).sort();
  if (tablesInSchema.join() !== [...workspaceTables].sort().join()) out.push(`schema tables ${tablesInSchema.length} != the ${workspaceTables.length} workspace tables`);
  const expectedObjects = [...workspaceTables, ...Object.keys(CORE_REFERENCE_TABLES)].sort();
  if (standard.map((o) => o.physical_table).sort().join() !== expectedObjects.join()) out.push(`standard objects ${standard.map((o) => o.physical_table).sort().join(',')}`);

  for (const t of workspaceTables) {
    const o = objectByTable.get(t);
    if (!o) continue;
    const own = fields.filter((f) => f.object === o.id && !f.is_custom && f.physical_column !== null);
    const actual = cols.filter((c) => c.t === t && !TENANT.has(c.c));
    const a = actual.map((c) => c.c).sort().join();
    const m = own.map((f) => f.physical_column!).sort().join();
    if (a !== m) out.push(`${t}: columns [${a}] vs fields [${m}]`);
    for (const c of actual) {
      const f = own.find((x) => x.physical_column === c.c);
      if (!f) continue;
      if (!fieldTypesFor(c.ty).includes(f.type)) out.push(`${t}.${c.c}: ${c.ty} mapped to ${f.type}`);
      if (f.is_nullable === c.nn) out.push(`${t}.${c.c}: nullability`);
      // Enumerated text: the field's options are exactly the CHECK's allowed values.
      const vals = new Set<string>();
      for (const k of checks.filter((x) => x.t === t)) {
        for (const mm of k.def.matchAll(/\(?(\w+) = ANY \(ARRAY\[([^\]]+)\]\)/g)) if (mm[1] === c.c) for (const v of mm[2]!.matchAll(/'([^']+)'::text/g)) vals.add(v[1]!);
      }
      const got = options.filter((x) => x.field === f.id).map((x) => x.value).sort();
      if (vals.size && got.join() !== [...vals].sort().join()) out.push(`${t}.${c.c}: options [${got.join()}] vs CHECK [${[...vals].sort().join()}]`);
      if (vals.size && f.type !== 'SELECT') out.push(`${t}.${c.c}: enumerated by a CHECK but ${f.type}`);
    }
    // Every FK to an id is exactly one MANY_TO_ONE relation to the target's object; every relation is backed by a constraint.
    for (const k of fks.filter((x) => x.t === t)) {
      const keyCols = k.cols.filter((c) => !TENANT.has(c));
      if (keyCols.length !== 1 || !k.tcols.includes('id')) continue;
      const targetTable = k.target_schema === 'core' ? CORE_REFERENCE_TABLES[k.target] : k.target;
      if (k.target_schema === 'core' && (k.target === 'organisation' || k.target === 'manager_workspace')) continue;
      const f = own.find((x) => x.physical_column === keyCols[0]);
      const target = targetTable ? objectByTable.get(targetTable) : undefined;
      if (!f || f.type !== 'RELATION' || !target || f.target_object !== target.id) out.push(`${t}: FK ${k.name} is not a relation to ${k.target}`);
    }
    for (const f of own.filter((x) => x.type === 'RELATION')) {
      const backed = fks.some((k) => k.t === t && k.cols.includes(f.physical_column!) && k.tcols.includes('id'));
      const enforcedBy = f.settings?.enforcedBy;
      // Structure level 22 (owner decision 0a): relations to core."user" have no FK; they must say they are service-enforced
      // and carry no ON DELETE. Any other relation must be backed by a constraint of the table.
      const toCoreUser = standard.find((o2) => o2.id === f.target_object)?.physical_table === 'user';
      if (toCoreUser) {
        if (backed || enforcedBy !== 'service:CoreReferenceService' || f.settings?.onDelete !== undefined) out.push(`${t}.${f.physical_column}: core user relation is not marked service-enforced`);
      } else if (!backed && !(typeof enforcedBy === 'string' && checks.some((k) => k.t === t && k.name === enforcedBy))) {
        out.push(`${t}.${f.physical_column}: relation without a constraint`);
      }
      if (f.settings?.relationType !== 'MANY_TO_ONE') out.push(`${t}.${f.physical_column}: relation type ${String(f.settings?.relationType)}`);
    }
  }
  // Inverse (ONE_TO_MANY) fields point back at their MANY_TO_ONE field, and the pair is symmetric.
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const f of fields.filter((x) => !x.is_custom && x.type === 'RELATION' && x.physical_column === null)) {
    const back = f.target_field ? byId.get(f.target_field) : undefined;
    if (!back || back.target_field !== f.id || back.object !== f.target_object || back.target_object !== f.object) out.push(`inverse ${f.name}: not a symmetric pair`);
  }
  return out;
}
