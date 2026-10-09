#!/usr/bin/env node
/**
 * Generates the canonical Workspace Schema Version 1 template (HWS Phase 3, physical-schema architecture).
 *
 * Source of truth: the catalogue of a database that holds the legacy core business tables (the reference baseline). The generator reads
 * the 15 workspace business tables from it and writes ONE authoritative definition. Every reference to one of those tables is rewritten to
 * the placeholder __WS__, which the provisioner replaces with a trusted, derived physical schema name. Core references stay explicitly
 * core-qualified.
 *
 * Connection: read ONLY from the environment variable HWS_TEMPLATE_SOURCE_URL. Nothing is printed except counts and the output path.
 * Output is deterministic: rerunning against the same catalogue produces identical bytes.
 *
 * Usage:  HWS_TEMPLATE_SOURCE_URL=postgres://... node tools/generate-workspace-schema-v1.js
 *
 * INTENTIONAL V1 DIFFERENCE (owner decision): user_note is workspace business data in V1. The legacy core.user_note has no workspace_id;
 * the V1 table adds `workspace_id uuid NOT NULL REFERENCES core.manager_workspace(id)` with a workspace-scoped policy and index. The legacy
 * table is NOT modified by this generator.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'packages', 'rab-server', 'src', 'database', 'typeorm', 'workspace-schema', 'v1');
const OUT_SQL = path.join(OUT_DIR, 'workspace-schema-v1.sql');
const OUT_TS = path.join(OUT_DIR, 'workspace-schema-v1.template.ts');

// The 15 workspace business tables, in a fixed order (this order is part of the definition).
const T = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report',
];
const WS_RE = new RegExp('core\\.(' + T.join('|') + ')\\b', 'g');
const rewrite = (s) => s.replace(WS_RE, '__WS__.$1');

/** The one intentional V1 difference. Applied after the catalogue read, so the legacy table is never touched. */
const USER_NOTE_V1 = {
  column: { attname: 'workspace_id', typ: 'uuid', attnotnull: true, dflt: null },
  fk: 'ALTER TABLE __WS__.user_note ADD CONSTRAINT "user_note_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id) ON DELETE CASCADE;',
  index: 'CREATE INDEX user_note_workspace_idx ON __WS__.user_note USING btree (workspace_id);',
  policy: 'CREATE POLICY "user_note_tenant" ON __WS__.user_note AS PERMISSIVE FOR ALL TO PUBLIC USING ((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())) WITH CHECK ((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()));',
};

/**
 * Manager-to-venue link is bound to the SAME workspace as the manager profile. The legacy FK only targets core.manager_profile(id), which
 * lets a Workspace B row point at a Workspace A profile. core.manager_profile already has UNIQUE (id, organisation_id, workspace_id), so
 * the physical FK targets that key. The authoritative manager-to-workspace relation is core.manager_profile.workspace_id.
 */
const FK_OVERRIDES = {
  manager_venue: {
    from: 'manager_venue_manager_profile_id_fkey',
    to: {
      conname: 'manager_venue_manager_profile_workspace_fkey',
      def: 'FOREIGN KEY (manager_profile_id, organisation_id, workspace_id) REFERENCES core.manager_profile(id, organisation_id, workspace_id) ON DELETE CASCADE',
    },
  },
};

/**
 * Manager-link visibility. The legacy policies read `workspace_id = current_workspace OR EXISTS(manager_venue ... manager_profile ...)`.
 * The EXISTS branch can only add rows whose workspace differs from the bound one, because every physical row already equals the bound
 * workspace in the first disjunct. That is exactly the cross-workspace widening, so V1 removes it: visibility is organisation AND
 * workspace, with no manager-link branch. Any policy that still contains EXISTS after this rewrite fails the generation.
 */
const WORKSPACE_ONLY_USING = '((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))';

/**
 * Reviewed policy that keeps a manager link. Every joined row is bound to the CURRENT workspace and organisation, the profile's
 * workspace is checked too, and the role check on WITH CHECK is unchanged. Joins use the physical manager_venue and venue tables
 * (the rewrite turns core.manager_venue and core.venue into the workspace schema).
 *   venue_manager_staff_scope (legacy): bound to core.manager_venue/core.venue (shared tables) without a profile-workspace check.
 */
const VMS_LINK =
  '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS (' +
  'SELECT 1 FROM (core.manager_profile mp JOIN __WS__.manager_venue mv ON ((mv.manager_profile_id = mp.id))) ' +
  'JOIN __WS__.venue v ON ((v.id = mv.venue_id)) ' +
  "WHERE ((mp.id = venue_manager_staff.manager_profile_id) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text) " +
  '  AND (mp.workspace_id = core.current_workspace()) AND (mp.organisation_id = core.current_org()) ' +
  '  AND (mv.workspace_id = core.current_workspace()) AND (mv.organisation_id = core.current_org()) ' +
  '  AND (v.workspace_id = core.current_workspace()) AND (v.organisation_id = core.current_org()))))';
const REVIEWED_EXISTS_OVERRIDES = {
  'venue_manager_staff.venue_manager_staff_scope': {
    using: `(${VMS_LINK})`,
    withCheck: `(${VMS_LINK}) AND (EXISTS (SELECT 1 FROM (core.user_role ur JOIN core.role r ON ((r.id = ur.role_id))) WHERE ((ur.user_id = core.current_uid()) AND (r.key = 'venue_manager'::text))))`,
  },
};

async function main() {
  const url = process.env.HWS_TEMPLATE_SOURCE_URL;
  if (!url) throw new Error('HWS_TEMPLATE_SOURCE_URL is required (the reference catalogue to read; never printed)');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  await c.connect();
  try {
    const out = [];
    const fkOverridesApplied = [];
    const policiesRewritten = [];
    const remainingExists = [];
    const reviewedExists = [];
    out.push('-- Workspace Schema Version 1 (GENERATED by tools/generate-workspace-schema-v1.js; authoritative). __WS__ = physical workspace schema.');
    out.push('-- Do not hand-edit. Regenerate from the reviewed reference catalogue. Intentional differences from legacy core, all listed in the generator:');
    out.push('--   user_note workspace_id + workspace policy; workspace_id NOT NULL on all 15 tables; manager_venue composite manager-profile FK;');
    out.push('--   manager-link OR EXISTS visibility branches removed (organisation AND workspace only).');
    for (const t of T) {
      const cols = (await c.query(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity, a.attgenerated
           FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = 'core' AND cl.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [t],
      )).rows;
      if (cols.some((k) => k.attidentity || k.attgenerated)) throw new Error(`identity/generated column in ${t} is not supported by the V1 generator`);
      // workspace_id is NOT NULL on every physical table (owner decision, Hyper Workspace hardening). A NULL-workspace row can never exist.
      const list = cols.map((k) => ({ attname: k.attname, typ: k.typ, attnotnull: k.attnotnull || k.attname === 'workspace_id', dflt: k.dflt }));
      if (t === 'user_note') list.push(USER_NOTE_V1.column);
      out.push(`\nCREATE TABLE __WS__.${t} (`);
      out.push(list.map((k) => `  "${k.attname}" ${k.typ}${k.dflt ? ' DEFAULT ' + rewrite(k.dflt) : ''}${k.attnotnull ? ' NOT NULL' : ''}`).join(',\n'));
      out.push(');');
    }
    // Constraints: every non-FK constraint of every table first (unique keys must exist before any FK targets them), then all FKs.
    for (const pass of [false, true]) {
      for (const t of T) {
        const cons = (await c.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def, contype FROM pg_constraint
            WHERE conrelid = ('core.' || quote_ident($1))::regclass ORDER BY (contype = 'f'), conname`,
          [t],
        )).rows;
        for (const k of cons) {
          if ((k.contype === 'f') !== pass) continue;
          const ov = FK_OVERRIDES[t];
          if (ov && k.conname === ov.from) {
            out.push(`ALTER TABLE __WS__.${t} ADD CONSTRAINT "${ov.to.conname}" ${ov.to.def};`);
            fkOverridesApplied.push(`${t}.${ov.from}`);
            continue;
          }
          out.push(`ALTER TABLE __WS__.${t} ADD CONSTRAINT "${k.conname}" ${rewrite(k.def)};`);
        }
        if (pass && t === 'user_note') out.push(USER_NOTE_V1.fk);
      }
    }
    for (const t of T) {
      // OID-based join, restricted to the core namespace. A name-based regclass cast would also resolve physical copies of the same
      // index name in workspace schemas and fail, so it is not used here.
      const idx = (await c.query(
        `SELECT ic.relname AS indexname, pg_get_indexdef(ic.oid) AS indexdef
           FROM pg_index x
           JOIN pg_class ic ON ic.oid = x.indexrelid
           JOIN pg_class tc ON tc.oid = x.indrelid
           JOIN pg_namespace n ON n.oid = tc.relnamespace
          WHERE n.nspname = 'core' AND tc.relname = $1
            AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ic.oid)
          ORDER BY ic.relname`,
        [t],
      )).rows;
      for (const k of idx) out.push(rewrite(k.indexdef).replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX ') + ';');
      if (t === 'user_note') out.push(USER_NOTE_V1.index);
    }
    for (const t of T) out.push(`ALTER TABLE __WS__.${t} ENABLE ROW LEVEL SECURITY;\nALTER TABLE __WS__.${t} FORCE ROW LEVEL SECURITY;`);
    const pols = (await c.query(
      `SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies
        WHERE schemaname = 'core' AND tablename = ANY($1) ORDER BY tablename, policyname`,
      [T],
    )).rows;
    for (const p of pols) {
      if (p.tablename === 'user_note') { out.push(USER_NOTE_V1.policy); continue; }
      const to = p.roles === '{public}' ? 'PUBLIC' : p.roles;
      const key = `${p.tablename}.${p.policyname}`;
      let using = p.qual ? rewrite(p.qual) : null;
      let withCheck = p.with_check ? rewrite(p.with_check) : null;
      if (p.qual && p.qual.includes('OR (EXISTS (')) {
        using = WORKSPACE_ONLY_USING;
        policiesRewritten.push(key);
      }
      if (REVIEWED_EXISTS_OVERRIDES[key]) {
        using = REVIEWED_EXISTS_OVERRIDES[key].using;
        withCheck = REVIEWED_EXISTS_OVERRIDES[key].withCheck;
        policiesRewritten.push(key);
        reviewedExists.push(key);
      }
      out.push(`CREATE POLICY "${p.policyname}" ON __WS__.${p.tablename} AS ${p.permissive} FOR ${p.cmd} TO ${to}` +
        (using ? ` USING (${using})` : '') + (withCheck ? ` WITH CHECK (${withCheck})` : '') + ';');
      if (using && using.includes('EXISTS') && !reviewedExists.includes(key)) remainingExists.push(key);
      if (withCheck && withCheck.includes('EXISTS') && !reviewedExists.includes(key)) remainingExists.push(key);
    }
    // Fail closed: every FK override must have matched, and no EXISTS policy may remain unreviewed.
    const missingOverrides = Object.entries(FK_OVERRIDES).flatMap(([t, ov]) => (fkOverridesApplied.includes(`${t}.${ov.from}`) ? [] : [`${t}.${ov.from}`]));
    if (missingOverrides.length) throw new Error(`FK override did not match the catalogue: ${missingOverrides.join(', ')}`);
    if (remainingExists.length) throw new Error(`policy still contains EXISTS and needs review: ${remainingExists.join(', ')}`);
    const trg = (await c.query(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, cl.relname FROM pg_trigger t
         JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname = 'core' AND cl.relname = ANY($1) ORDER BY cl.relname, t.tgname`,
      [T],
    )).rows;
    for (const g of trg) out.push(rewrite(g.def) + ';');
    for (const t of T) out.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON __WS__.${t} TO rab_app;`);

    const sql = out.join('\n') + '\n';
    if (sql.includes('`') || sql.includes('${')) throw new Error('generated SQL contains a backtick or ${ and cannot be embedded');
    const ts = '/* GENERATED by tools/generate-workspace-schema-v1.js. Do not hand-edit. */\n' +
      '/** Workspace Schema Version 1: the single authoritative definition of the 15 workspace business tables. __WS__ is replaced by the trusted physical schema name. */\n' +
      'export const WORKSPACE_SCHEMA_V1_TEMPLATE = `' + sql + '`;\n';
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_SQL, sql);
    fs.writeFileSync(OUT_TS, ts);
    const digest = crypto.createHash('sha256').update(sql).digest('hex');
    console.log(JSON.stringify({
      tables: T.length, policies: pols.length, policiesRewritten: policiesRewritten.length, fkOverrides: fkOverridesApplied.length,
      triggers: trg.length, bytes: Buffer.byteLength(sql), sha256: digest,
    }));
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error('generator failed:', err.message);
  process.exit(1);
});
