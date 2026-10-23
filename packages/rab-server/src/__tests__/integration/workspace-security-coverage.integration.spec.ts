import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { compareWithGolden } from '../../database/typeorm/core/security-posture';

/**
 * F4 (Wave 1 lane S): `tools/check-rls-coverage.ts` and the security-posture golden snapshot now cover every physical
 * `workspace_<32 hex>` schema. Proven against DELIBERATELY BROKEN, DISPOSABLE workspace schemas: each case provisions a
 * fresh workspace through the real server path (`core.provision_workspace` as crewflow_app), breaks exactly one thing as
 * the bootstrap superuser, and requires BOTH tools to fail and to name that schema — then drops the whole workspace.
 * A healthy fresh workspace must pass both (no line about it at all).
 *
 * The tools scan the whole database, so assertions are about the disposable schema's own lines; other schemas on a shared
 * test database are not this test's business.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(180_000);

const REPO_ROOT = resolve(__dirname, '../../../../..');
const GOLDEN = join(__dirname, '../../database/typeorm/core/security-posture.golden.txt');

interface Ws {
  id: string;
  org: string;
  owner: string;
  schema: string;
}

describeIfDb('F4: workspace schemas are covered by check-rls-coverage and the posture snapshot (deliberately broken schemas)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const suffix = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  const golden = readFileSync(GOLDEN, 'utf8').split('\n').filter(Boolean);

  const provisionDisposable = async (label: string): Promise<Ws> => {
    const r = await admin.query(
      `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
            u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                  SELECT id, $1::text || '@f4.invalid', 'F4', 'Owner', 'active' FROM o RETURNING id, organisation_id)
       INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
       SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id, organisation_id, owner_user_id`,
      [`f4-${label}-${suffix}`],
    );
    const ws = { id: r.rows[0].id, org: r.rows[0].organisation_id, owner: r.rows[0].owner_user_id, schema: `workspace_${String(r.rows[0].id).replace(/-/g, '')}` };
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [ws.org, ws.owner]);
      const { rows } = await app.query('SELECT core.provision_workspace($1) AS o', [ws.id]);
      await app.query('COMMIT');
      expect(rows[0].o).toBe('READY');
    } finally {
      await app.end();
    }
    return ws;
  };

  const dropDisposable = async (ws: Ws) => {
    await admin.query(`DROP SCHEMA IF EXISTS ${ws.schema} CASCADE`);
    await admin.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [ws.id]);
    await admin.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [ws.id]);
  };

  /** check-rls-coverage as the real runtime login, exactly as CI runs it. Only the lines naming this schema are returned. */
  const rlsCoverage = (schema: string) => {
    const out = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), join(REPO_ROOT, 'tools/check-rls-coverage.ts')], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: appUrl },
      encoding: 'utf8',
      timeout: 150_000,
    });
    const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
    return { status: out.status, lines: text.split('\n').filter((l) => l.includes(schema)).map((l) => l.trim()) };
  };

  const postureDrift = async (schema: string) => (await compareWithGolden(adminUrl, golden)).workspaces.find((d) => d.schema === schema);

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const [{ rolsuper }] = (await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows;
    if (!rolsuper) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    expect(golden.filter((l) => l.startsWith('ws|')).length).toBeGreaterThan(300);
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('a freshly provisioned workspace passes both: no RLS-coverage line and no posture drift for it', async () => {
    const ws = await provisionDisposable('healthy');
    try {
      expect(rlsCoverage(ws.schema).lines).toEqual([]);
      expect(await postureDrift(ws.schema)).toBeUndefined();
    } finally {
      await dropDisposable(ws);
    }
  });

  const cases: Array<{ label: string; breakIt: (s: string) => string; rls: RegExp | null; posture: RegExp }> = [
    {
      label: 'FORCE RLS removed from a table',
      breakIt: (s) => `ALTER TABLE ${s}.shift NO FORCE ROW LEVEL SECURITY`,
      rls: /\.shift: rowsecurity=true forceRowSecurity=false/,
      posture: /^\+ ws\|rls\|shift\|enable=true\|force=false$/,
    },
    {
      label: 'a table handed to the wrong owner',
      breakIt: (s) => `ALTER TABLE ${s}.venue OWNER TO rab_secure_owner`,
      rls: /\.venue: owned by "rab_secure_owner", expected crewflow/,
      posture: /^\+ ws\|owner\|r\|venue\|rab_secure_owner$/,
    },
    {
      label: 'an extra grant to the runtime role (DELETE on payroll rows)',
      breakIt: (s) => `GRANT DELETE ON ${s}.payroll_record TO crewflow_app`,
      rls: /\.payroll_record: extra grant crewflow_app:DELETE:false/,
      posture: /^\+ ws\|acl\|payroll_record\|crewflow_app\|DELETE,INSERT,SELECT$/,
    },
    {
      label: 'a grant to PUBLIC',
      breakIt: (s) => `GRANT SELECT ON ${s}.staff_profile TO PUBLIC`,
      rls: /\.staff_profile: extra grant PUBLIC:SELECT:false/,
      posture: /^\+ ws\|acl\|staff_profile\|PUBLIC\|SELECT$/,
    },
    {
      label: 'a missing RLS policy',
      breakIt: (s) => `DROP POLICY payroll_record_select ON ${s}.payroll_record`,
      rls: null, // other payroll_record policies remain, so the per-table invariants still hold; the exact model is the snapshot's job
      posture: /^- ws\|policy\|payroll_record\|payroll_record_select\|/,
    },
    {
      label: 'the only policy of a table removed',
      breakIt: (s) => `DROP POLICY shift_tenant ON ${s}.shift`,
      rls: /\.shift: no RLS policy/,
      posture: /^- ws\|policy\|shift\|shift_tenant\|/,
    },
    {
      label: 'a view injected into the schema (would read past RLS as its owner)',
      breakIt: (s) => `CREATE VIEW ${s}.leak AS SELECT id FROM ${s}.payroll_record`,
      rls: /unexpected object \(v leak\)/,
      posture: /^\+ ws\|owner\|v\|leak\|/,
    },
    {
      label: 'the runtime role given CREATE on the schema',
      breakIt: (s) => `GRANT CREATE ON SCHEMA ${s} TO crewflow_app`,
      rls: /crewflow_app has CREATE on the schema/,
      posture: /^\+ ws\|schema\|crewflow_app\|usage=true\|create=true$/,
    },
    {
      label: 'F3 regression: payroll evidence FK back to ON DELETE CASCADE',
      breakIt: (s) =>
        `ALTER TABLE ${s}.payroll_record DROP CONSTRAINT payroll_record_attendance_id_fkey, ` +
        `ADD CONSTRAINT payroll_record_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES ${s}.attendance(id) ON DELETE CASCADE`,
      rls: null, // FK actions are not an RLS invariant; the snapshot catches them
      posture: /^\+ ws\|fk\|payroll_record\|payroll_record_attendance_id_fkey\|.*ON DELETE CASCADE$/,
    },
  ];

  it.each(cases)('$label: both tools fail and name the schema', async ({ label, breakIt, rls, posture }) => {
    const ws = await provisionDisposable(label.replace(/[^a-z0-9]+/gi, '-').slice(0, 20).toLowerCase());
    try {
      await admin.query(breakIt(ws.schema));

      const drift = await postureDrift(ws.schema);
      expect(drift).toBeDefined();
      const driftLines = [...drift!.missing.map((l) => `- ${l}`), ...drift!.unexpected.map((l) => `+ ${l}`)];
      expect(driftLines.some((l) => posture.test(l))).toBe(true);

      if (rls) {
        const result = rlsCoverage(ws.schema);
        expect(result.status).toBe(1);
        expect(result.lines.some((l) => rls.test(l))).toBe(true);
      }
    } finally {
      await dropDisposable(ws);
    }
  });
});
