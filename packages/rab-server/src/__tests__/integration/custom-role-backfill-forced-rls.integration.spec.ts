import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';

import { AppModule } from '../../app.module';
import { BackfillCustomRoleObjectRules1786717200000 } from '../../database/typeorm/core/migrations/1786717200000-BackfillCustomRoleObjectRules';
import { BackfillCustomRoleObjectRulesUnderForcedRls1786717600000 } from '../../database/typeorm/core/migrations/1786717600000-BackfillCustomRoleObjectRulesUnderForcedRls';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * F-08: the custom-role object-rule backfill must work under the real production-style migration role `crewflow`
 * (NOSUPERUSER, NOBYPASSRLS, owner of the FORCE-RLS role tables), not only under a superuser.
 *
 * Each migration runs inside a transaction that has switched to `crewflow` with SET LOCAL ROLE, so every policy is enforced
 * exactly as it would be for a production migration run. The superuser admin connection is used only to build fixtures and
 * to read the results back.
 *
 * Proves: (1) the historical 1786717200000 is a silent no-op under `crewflow`, which is the defect; (2) the superseding
 * 1786717600000 backfills exactly the flagged objects for legacy roles in every organisation and workspace; (3) editor-made
 * rules, field rules, system roles and roles without view flags are preserved untouched; (4) a second run changes nothing.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

type Rule = {
  role_id: string;
  object_key: string;
  can_read: boolean | null;
  record_filter: unknown;
  updated_at: string;
};

describeIfDb(
  'F-08: custom-role object-rule backfill under the restricted migration role (integration)',
  () => {
    jest.setTimeout(180_000);

    let app: INestApplication;
    let admin: DataSource;
    let managerA: TestIdentity;
    let managerB: TestIdentity;
    const roles: Record<
      | 'legacyA'
      | 'legacyB'
      | 'edited'
      | 'noFlags'
      | 'secondLegacyA'
      | 'readAll',
      string
    > = {} as never;

    async function asMigrationRole(
      run: (qr: QueryRunner) => Promise<void>,
    ): Promise<void> {
      const qr = admin.createQueryRunner();
      await qr.connect();
      try {
        await qr.startTransaction();
        await qr.query(`SET LOCAL ROLE crewflow`);
        const [who] = await qr.query(
          `SELECT current_user AS "user", r.rolsuper AS "super", r.rolbypassrls AS "bypass" FROM pg_roles r WHERE r.rolname = current_user`,
        );
        // Fail closed: if the run is not genuinely restricted, the test proves nothing.
        expect(who).toEqual({ user: 'crewflow', super: false, bypass: false });
        await run(qr);
        await qr.commitTransaction();
      } catch (error) {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        throw error;
      } finally {
        await qr.release();
      }
    }

    const rulesFor = async (ids: string[]): Promise<Rule[]> =>
      admin.query(
        `SELECT role_id, object_key, can_read, record_filter, updated_at::text AS updated_at
         FROM core.role_object_permission WHERE role_id = ANY($1::uuid[]) ORDER BY role_id, object_key`,
        [ids],
      );

    async function insertCustomRole(
      owner: TestIdentity,
      flags: string[],
    ): Promise<string> {
      const [row] = await admin.query(
        `INSERT INTO core.role (organisation_id, workspace_id, key, name, is_system, can_read_all_objects)
       VALUES ($1, $2, $3, $4, false, false) RETURNING id`,
        [
          owner.organisationId,
          owner.workspaceId,
          `custom_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          `Legacy ${randomUUID().slice(0, 6)}`,
        ],
      );
      if (flags.length) {
        await admin.query(
          `INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
         SELECT $1, p.id, $2 FROM core.permission p WHERE p.key = ANY($3::text[])`,
          [row.id, owner.organisationId, flags],
        );
      }
      return row.id as string;
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      admin = createAdminDataSource();
      await admin.initialize();
      const factory = new TestIdentityFactory({
        app,
        dataSource: moduleRef.get(DataSource),
        adminDataSource: admin,
        tenantContext: moduleRef.get(TenantContextService),
        passwordHashing: moduleRef.get(PasswordHashingService),
      });
      // Two organisations, each with its own workspace: the backfill must reach both.
      managerA = (
        await factory.createOrganisationWithManagers(1, {
          permissions: 'production',
          workspace: true,
          label: 'f08a',
        })
      ).managers[0]!;
      managerB = (
        await factory.createOrganisationWithManagers(1, {
          permissions: 'production',
          workspace: true,
          label: 'f08b',
        })
      ).managers[0]!;

      roles.legacyA = await insertCustomRole(managerA, [
        'staff.view',
        'schedule.view',
      ]);
      roles.legacyB = await insertCustomRole(managerB, ['venue.view']);
      roles.edited = await insertCustomRole(managerA, [
        'staff.view',
        'venue.view',
      ]);
      roles.noFlags = await insertCustomRole(managerB, []);
      roles.secondLegacyA = await insertCustomRole(managerA, ['staff.view']);
      // Editor-made "All Objects" role with no per-object rules (a real shape found in the restored development data).
      roles.readAll = await insertCustomRole(managerB, [
        'staff.view',
        'venue.view',
        'schedule.view',
      ]);
      await admin.query(
        `UPDATE core.role SET can_read_all_objects = true WHERE id = $1`,
        [roles.readAll],
      );
      // An editor-made definition: staff explicitly DENIED with a record filter. It must never be overridden or extended.
      await admin.query(
        `INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read, record_filter)
       VALUES ($1, $2, $3, 'staff', false, '{"op":"and","conditions":[]}'::jsonb)`,
        [roles.edited, managerA.workspaceId, managerA.organisationId],
      );
    });

    afterAll(async () => {
      await admin?.destroy();
      await app?.close();
    });

    it('the restricted role cannot see the role tables without tenant context (precondition for F-08)', async () => {
      await asMigrationRole(async (qr) => {
        expect(
          await qr.query(
            `SELECT id FROM core.role WHERE id = ANY($1::uuid[])`,
            [Object.values(roles)],
          ),
        ).toEqual([]);
      });
    });

    it('historical 1786717200000 is a silent no-op under crewflow (the defect)', async () => {
      await asMigrationRole((qr) =>
        new BackfillCustomRoleObjectRules1786717200000().up(qr),
      );
      expect(
        await rulesFor([
          roles.legacyA,
          roles.legacyB,
          roles.noFlags,
          roles.secondLegacyA,
        ]),
      ).toEqual([]);
    });

    it('1786717600000 backfills exactly the flagged objects, in every organisation and workspace, and preserves existing rules', async () => {
      const editedBefore = await rulesFor([roles.edited]);
      await asMigrationRole((qr) =>
        new BackfillCustomRoleObjectRulesUnderForcedRls1786717600000().up(qr),
      );

      const legacyA = await rulesFor([roles.legacyA]);
      expect(
        legacyA.map((r) => [r.object_key, r.can_read, r.record_filter]),
      ).toEqual([
        ['shift', true, null],
        ['staff', true, null],
      ]);
      const legacyB = await rulesFor([roles.legacyB]);
      expect(
        legacyB.map((r) => [r.object_key, r.can_read, r.record_filter]),
      ).toEqual([['venue', true, null]]);
      expect(
        (await rulesFor([roles.secondLegacyA])).map((r) => r.object_key),
      ).toEqual(['staff']);
      // Rows carry the role's own tenant, never another workspace's.
      const [scope] = await admin.query(
        `SELECT count(*)::int AS n FROM core.role_object_permission x JOIN core.role r ON r.id = x.role_id
        WHERE x.role_id = ANY($1::uuid[]) AND (x.workspace_id <> r.workspace_id OR x.organisation_id <> r.organisation_id)`,
        [[roles.legacyA, roles.legacyB]],
      );
      expect(scope.n).toBe(0);

      expect(await rulesFor([roles.edited])).toEqual(editedBefore);
      expect(await rulesFor([roles.noFlags])).toEqual([]);
      expect(await rulesFor([roles.readAll])).toEqual([]);
      // No field becomes visible and no flag or version changes.
      expect(
        await admin.query(
          `SELECT 1 FROM core.role_field_permission WHERE role_id = ANY($1::uuid[])`,
          [Object.values(roles)],
        ),
      ).toEqual([]);
      const versions = await admin.query(
        `SELECT permission_version::int AS v, can_read_all_objects AS all FROM core.role WHERE id = ANY($1::uuid[])`,
        [Object.values(roles)],
      );
      expect(versions.every((r: { v: number }) => r.v === 1)).toBe(true);
      const readAllIds = (
        await admin.query(
          `SELECT id FROM core.role WHERE id = ANY($1::uuid[]) AND can_read_all_objects`,
          [Object.values(roles)],
        )
      ).map((r: { id: string }) => r.id);
      expect(readAllIds).toEqual([roles.readAll]);
    });

    it('a second run under crewflow is a no-op (idempotent)', async () => {
      const before = await rulesFor(Object.values(roles));
      await asMigrationRole((qr) =>
        new BackfillCustomRoleObjectRulesUnderForcedRls1786717600000().up(qr),
      );
      expect(await rulesFor(Object.values(roles))).toEqual(before);
    });

    it('leaves no tenant context bound after it runs', async () => {
      await asMigrationRole(async (qr) => {
        await new BackfillCustomRoleObjectRulesUnderForcedRls1786717600000().up(
          qr,
        );
        const [ctx] = await qr.query(
          `SELECT core.current_org() AS org, core.current_workspace() AS ws`,
        );
        expect(ctx).toEqual({ org: null, ws: null });
        expect(
          await qr.query(
            `SELECT id FROM core.role WHERE id = ANY($1::uuid[])`,
            [Object.values(roles)],
          ),
        ).toEqual([]);
      });
    });
  },
);
