import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { WorkspaceCoreForeignKeyRemoval1786721490000 } from '../../database/typeorm/core/migrations/1786721490000-WorkspaceCoreForeignKeyRemoval';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { assertUsersOfOrganisationTx } from '../../engine/core-modules/core-references/core-references';
import { protectedWorkspaceReference, userReferenceColumns } from '../../engine/core-modules/core-references/workspace-user-references';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { UserDeletionBlockedException, UserDeletionService } from '../../engine/core-modules/user-deletion/user-deletion.service';
import { dropWorkspaceSchema, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (structure level 22; SQL pending owner OK): every case a dropped workspace → core foreign
 * key used to refuse is refused (or carried out) by the application instead. Real PostgreSQL, a level-22 workspace built by the
 * TypeScript provisioner, the application's own services on the runtime login with the tenant bound:
 *  - organisation_id / workspace_id: a row naming another organisation, another workspace or no existing organisation is refused
 *    by FORCE RLS / the per-table binding CHECK (no foreign key needed);
 *  - a user id from anything but the actor: assertUsersOfOrganisationTx → 404 for a missing user and for another organisation's
 *    user (stricter than the old FK, which accepted any organisation's user);
 *  - the former RESTRICT (Q3): a hard delete of a user still referenced by a no-ON-DELETE column of a workspace → 409;
 *  - the former CASCADE / SET NULL (Q2): the hard delete removes the user's own staff profile and the notes about them and clears
 *    the SET NULL columns, in the same transaction;
 *  - the 0a migration's down() refuses while a level-22 workspace exists (nothing changed).
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('Part D 0a: the application enforces what the workspace → core foreign keys did (integration)', () => {
  const { adminUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let moduleRef: TestingModule;
  let runtime: DataSource;
  let deletion: UserDeletionService;
  let admin: Client;
  let w: SeededWorkspace;
  let other: SeededWorkspace;
  const created: SeededWorkspace[] = [];

  const user = async (org: string, label: string): Promise<string> =>
    (await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'F', 'K', 'active') RETURNING id`, [org, `${label}-${randomUUID().slice(0, 8)}@ws0a.invalid`]))
      .rows[0].id as string;
  /** The workspace owner as the caller: a manager of THIS workspace (its manager branches of RLS apply), tenant bound. */
  const ctxOf = (ws: SeededWorkspace): AuthContext => ({ organisationId: ws.org, workspaceId: ws.id, userId: ws.owner, role: 'manager' }) as AuthContext;
  const asOwner = <T>(ws: SeededWorkspace, fn: (m: EntityManager) => Promise<T>): Promise<T> =>
    runtime.transaction(async (m) => {
      await m.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true),
                set_config('rab.role', 'manager', true), set_config('rab.actor_type', 'user', true), set_config('search_path', 'core', true)`,
        [ws.org, ws.id, ws.owner],
      );
      return fn(m);
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    runtime = moduleRef.get(DataSource);
    deletion = moduleRef.get(UserDeletionService);
    for (const n of ['w', 'other']) {
      const ws = await seedWorkspace(admin, `ws0a-app-${n}-${SFX}`);
      created.push(ws);
      expect(await provisionTypeScript(adminUrl, ws)).toBe('READY');
      expect((await registryOf(admin, ws.id)).module_version).toBe(22);
      // The owner is an internal manager of its own workspace (the manager branches of the workspace RLS).
      await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [ws.org, ws.owner, ws.id]);
    }
    [w, other] = created as [SeededWorkspace, SeededWorkspace];
  });

  afterAll(async () => {
    for (const ws of created) {
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    }
    await moduleRef?.close();
    await admin?.end();
  });

  it('the level-22 workspace has no foreign key to core."user", core.organisation or core.manager_workspace left', async () => {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace s ON s.oid = k.connamespace
        WHERE s.nspname = $1 AND k.contype = 'f' AND k.confrelid IN ('core."user"'::regclass, 'core.organisation'::regclass, 'core.manager_workspace'::regclass)`,
      [w.schema],
    );
    expect(rows[0].n).toBe(0);
    expect(userReferenceColumns()).toHaveLength(31);
  });

  it('organisation_id / workspace_id: another organisation, another workspace or a missing organisation is refused (RLS / binding CHECK)', async () => {
    const attempt = (org: string, ws: string) =>
      asOwner(w, async (m) => m.query(`INSERT INTO ${w.schema}.job_role (organisation_id, name, workspace_id) VALUES ($1, 'fk-probe', $2)`, [org, ws])).then(
        () => 'inserted',
        (e: { driverError?: { code?: string }; code?: string }) => e.driverError?.code ?? e.code ?? 'error',
      );
    expect(await attempt(w.org, w.id)).toBe('inserted');
    expect(['42501', '23514']).toContain(await attempt(other.org, w.id));
    expect(['42501', '23514']).toContain(await attempt(w.org, other.id));
    expect(['42501', '23514']).toContain(await attempt(randomUUID(), w.id));
  });

  it('a user id from anything but the actor: a missing user and another organisation\'s user are 404 (stricter than the old FK)', async () => {
    const own = await user(w.org, 'own');
    const foreign = await user(other.org, 'foreign');
    await asOwner(w, async (m) => {
      await expect(assertUsersOfOrganisationTx(m, w.org, [own])).resolves.toBeUndefined();
    });
    for (const id of [randomUUID(), foreign]) {
      await expect(asOwner(w, (m) => assertUsersOfOrganisationTx(m, w.org, [id]))).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('the former RESTRICT: a user still referenced by a no-ON-DELETE workspace column cannot be hard-deleted (409)', async () => {
    const target = await user(w.org, 'restrict');
    await admin.query(`INSERT INTO ${w.schema}.venue (organisation_id, name, workspace_id, created_by) VALUES ($1, $2, $3, $4)`, [w.org, `fk-venue-${SFX}`, w.id, target]);
    expect(await asOwner(w, (m) => protectedWorkspaceReference(m, ctxOf(w), target))).toBe('venue.created_by');
    await expect(asOwner(w, (m) => deletion.assertCanDelete(m, ctxOf(w), target))).rejects.toBeInstanceOf(UserDeletionBlockedException);
    expect((await admin.query(`SELECT count(*)::int AS n FROM core."user" WHERE id = $1`, [target])).rows[0].n).toBe(1);
  });

  it('the former CASCADE / SET NULL: the hard delete removes the user\'s own staff profile and the notes about them, and clears the attribution', async () => {
    const target = await user(w.org, 'cascade');
    const staff = (
      await admin.query(`INSERT INTO ${w.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        w.org,
        target,
        `FK-${SFX}`,
        w.id,
        w.owner,
      ])
    ).rows[0].id;
    await admin.query(`INSERT INTO ${w.schema}.user_note (organisation_id, subject_user_id, author_user_id, body, workspace_id) VALUES ($1, $2, $3, 'about', $4)`, [w.org, target, w.owner, w.id]);
    const authored = (
      await admin.query(`INSERT INTO ${w.schema}.user_note (organisation_id, subject_user_id, author_user_id, body, workspace_id) VALUES ($1, $2, $3, 'by', $4) RETURNING id`, [w.org, w.owner, target, w.id])
    ).rows[0].id;
    await asOwner(w, async (m) => {
      await deletion.assertCanDelete(m, ctxOf(w), target);
      await deletion.deleteUser(m, ctxOf(w), target, 'cascade@ws0a.invalid');
    });
    expect((await admin.query(`SELECT count(*)::int AS n FROM core."user" WHERE id = $1`, [target])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ${w.schema}.staff_profile WHERE id = $1`, [staff])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ${w.schema}.user_note WHERE subject_user_id = $1`, [target])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT author_user_id FROM ${w.schema}.user_note WHERE id = $1`, [authored])).rows[0].author_user_id).toBeNull();
  });

  it('down() of WorkspaceCoreForeignKeyRemoval1786721490000 refuses while a level-22 workspace exists (nothing changed)', async () => {
    const bodies = async () =>
      (await admin.query(`SELECT pg_catalog.md5(p.prosrc) AS h FROM pg_catalog.pg_proc p WHERE p.oid IN ('core.provision_workspace(uuid)'::regprocedure, 'core.verify_workspace_schema_v1(uuid)'::regprocedure) ORDER BY 1`)).rows;
    const before = await bodies();
    const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceCoreForeignKeyRemoval1786721490000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: \d+ workspace schema\(s\) are at structure level 22/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await bodies()).toEqual(before);
  });
});
