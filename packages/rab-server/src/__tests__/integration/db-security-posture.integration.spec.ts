import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { compareWithGolden } from '../../database/typeorm/core/security-posture';

/**
 * G-03 / CF-09 / CF-41 / CF-48: the test database must have exactly the ownership and grant model a database built from
 * migrations alone produces (the committed golden snapshot). A hand-applied grant on a long-lived test database once hid a
 * fresh-install outage (every cookie request 503). Any drift, in either direction, fails here with the exact lines.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('database security posture (integration)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);

  it('matches the golden snapshot produced by a migrations-only build (core, and EVERY workspace schema against the template)', async () => {
    const expected = readFileSync(join(__dirname, '../../database/typeorm/core/security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);
    const report = await compareWithGolden(adminUrl, expected);
    expect(report.core).toEqual({ missing: [], unexpected: [] });
    // F4: each physical workspace_<32 hex> schema on its own. A drifted one is named here with its exact lines.
    expect(report.workspaces).toEqual([]);
  });

  it('CF-09: the restricted runtime role can resolve a web session and cannot run provisioner-only or ledger writes', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      const [who] = (await client.query(`SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`)).rows;
      // I-class (owner-login architecture, BC-02): the one runtime login is crewflow_owner; NOSUPERUSER / NOBYPASSRLS kept.
      // The only other runtime accepted here is crewflow_app on the LEGACY separated database that ci-migration-security's
      // restricted-migrator job still builds (LEGACY, REMOVE IN PR #9): there the original separated-mode assertions run
      // unchanged, the runtime login itself must be refused (42501).
      expect(['crewflow_owner', 'crewflow_app']).toContain(who.u);
      expect({ s: who.s, b: who.b }).toEqual({ s: false, b: false });
      const legacySeparated = who.u === 'crewflow_app';
      // A real call, not only a catalog check: an unknown hash resolves to no row (and no permission error).
      expect((await client.query(`SELECT * FROM core.auth_find_session_by_web_token_hash($1)`, ['0'.repeat(64)])).rows).toEqual([]);
      // P-class (owner-login architecture): the schema role crewflow_app still cannot run the provisioner-only function or
      // write the ledger, the reference tables or audit_log (42501), checked through the fixture superuser's SET LOCAL ROLE.
      if (legacySeparated) {
        await expect(client.query(`SELECT core.register_workspace_schema(gen_random_uuid())`)).rejects.toMatchObject({ code: '42501' });
        await expect(client.query(`UPDATE core.permission SET key = key WHERE false`)).rejects.toMatchObject({ code: '42501' });
        await expect(client.query(`DELETE FROM core.migrations WHERE false`)).rejects.toMatchObject({ code: '42501' });
        await expect(client.query(`DELETE FROM core.audit_log WHERE false`)).rejects.toMatchObject({ code: '42501' });
        return;
      }
      const writes = [
        `SELECT core.register_workspace_schema(gen_random_uuid())`,
        `UPDATE core.permission SET key = key WHERE false`,
        `DELETE FROM core.migrations WHERE false`,
        `DELETE FROM core.audit_log WHERE false`,
      ];
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        for (const sql of writes) {
          await admin.query('BEGIN');
          try {
            await admin.query(`SELECT set_config('role', 'crewflow_app', true)`);
            const code = await admin.query(sql).then(
              () => 'OK',
              (e: { code?: string }) => e.code ?? 'ERROR',
            );
            expect({ sql, code }).toEqual({ sql, code: '42501' });
          } finally {
            await admin.query('ROLLBACK').catch(() => undefined);
          }
        }
      } finally {
        await admin.end();
      }
      // The runtime login crewflow_owner:
      //  - reaches the provisioner-only function body (OWNER-LOGIN DIFFERENCE PROV-1, NEEDS OWNER APPROVAL) and is refused
      //    there: an unknown workspace is P0002, nothing is registered;
      //  - audit_log stays insert-only against DML: the table owner crewflow holds only SELECT/INSERT on it (42501);
      //  - core.permission / core.migrations (global, no RLS): REF-1 is an OPEN DEFECT with the owner (Agent 5 finding, parity
      //    guard proposed; NOT accepted). The assertion stays STRICT: the runtime login must be refused (42501). It fails until
      //    the guard lands. WHERE false and rolled back, so nothing can change either way.
      await expect(client.query(`SELECT core.register_workspace_schema(gen_random_uuid())`)).rejects.toMatchObject({ code: 'P0002' });
      await expect(client.query(`DELETE FROM core.audit_log WHERE false`)).rejects.toMatchObject({ code: '42501' });
      for (const sql of [`UPDATE core.permission SET key = key WHERE false`, `DELETE FROM core.migrations WHERE false`]) {
        await client.query('BEGIN');
        try {
          const code = await client.query(sql).then(
            () => 'OK',
            (e: { code?: string }) => e.code ?? 'ERROR',
          );
          expect({ sql, code }).toEqual({ sql, code: '42501' });
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
        }
      }
    } finally {
      await client.end();
    }
  });
});
