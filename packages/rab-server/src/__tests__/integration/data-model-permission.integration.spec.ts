/**
 * Metadata engine M2, phase 1 (docs/plans/phase-x4/M2-PLAN.md §10 S-2, PR-1 / PR-2; owner decisions 2026-11-18): the
 * `data_model.manage` role permission on the real disposable test database (migrations alone, owner-login bootstrap).
 *
 *   DP-1   the catalogue row exists (DataModelManagePermission1786721630000).
 *   DP-2   the migration's grant block, run as the owner-login migration identity (crewflow_owner, no tenant bound):
 *          organisations are found through the definer keyset function although core.organisation is FORCE RLS; the
 *          ceo and manager system roles get the flag (permission_version bumped); venue_manager, staff and every other
 *          role do not; idempotent; the revoke block (down) removes it again.
 *   DP-3   layer 2 against PostgreSQL (DataModelAuthorityService + PermissionsService.userHasPermissionTx, the runtime
 *          login, FORCE RLS): CEO and Manager allowed; Venue Manager, Staff, a user with no role, a Manager with a per-user
 *          revoke, a CEO bound to another organisation and an Admin Inspect session refused with 403 PERMISSION_DENIED.
 *   DP-4   owner decision: a custom workspace-member role can never be granted the flag (the member allowlist trigger,
 *          unchanged; refused even to the superuser).
 * Fixtures are committed by the cluster superuser and removed with their organisations; every runtime-login mutation is
 * rolled back. No URL or password is ever printed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PermissionFlag } from '@rab/shared';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import {
  DATA_MODEL_MANAGE_GRANT_SQL,
  DATA_MODEL_MANAGE_REVOKE_SQL,
} from '../../database/typeorm/core/migrations/1786721630000-DataModelManagePermission';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { DataModelPermissionDeniedException } from '../../engine/metadata/exceptions/data-model.exceptions';
import { DataModelAuthorityService } from '../../engine/metadata/services/data-model-authority.service';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../../modules/staff/services/staff.service';

jest.setTimeout(300_000);

const MIGRATION_ON_BRANCH = existsSync(join(__dirname, '..', '..', 'database', 'typeorm', 'core', 'migrations', '1786721630000-DataModelManagePermission.ts'));
const env = resolveIntegrationTestDatabase(process.env);
const OWNER_URL = env.appUrl;
const ADMIN_URL = env.adminUrl;
const loginOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
};
if (MIGRATION_ON_BRANCH && loginOf(OWNER_URL) !== 'crewflow_owner') {
  throw new Error('data-model-permission spec: TEST_DATABASE_URL must be the runtime login crewflow_owner (DataModelManagePermission1786721630000 is on this branch)');
}
const RUN = MIGRATION_ON_BRANCH;
const describeIfDm = RUN ? describe : describe.skip;
const RUN_ID = randomBytes(4).toString('hex');
const ARGON = '$argon2id$v=19$m=19456,t=2,p=1$ZG0xc2FsdGRtMXNhbHQ$ZG0tbm90LWEtcmVhbC1oYXNoLTAwMDAwMDAwMDAwMDAw';

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, application_name: 'data-model-permission-spec' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const asAdmin = <T>(fn: (c: Client) => Promise<T>) => withClient(ADMIN_URL, fn);
const asOwner = <T>(fn: (c: Client) => Promise<T>) => withClient(OWNER_URL, fn);

async function rolledBack<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<string | null> {
  await c.query('SAVEPOINT dm_try');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT dm_try');
    return null;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT dm_try');
    return (e as { code?: string }).code ?? 'unknown';
  }
}

const BIND_SQL =
  "SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', 'user', true)";

/** The four system roles of an organisation, with the PRODUCTION default sets (ROLE_DEFS + Staff), as a new organisation gets them. */
const SYSTEM_ROLES: Record<string, readonly string[]> = {
  ...Object.fromEntries(Object.values(ROLE_DEFS).map((d) => [d.key, d.permissions])),
  [STAFF_ROLE_KEY]: STAFF_ROLE_PERMISSIONS,
};

interface Org {
  org: string;
  workspace: string;
  roles: Record<string, string>; // key -> role id
  users: Record<string, string>; // label -> user id
}

describeIfDm('metadata engine M2 phase 1: data_model.manage, a role permission (DataModelManagePermission1786721630000)', () => {
  const orgs: string[] = [];
  let P: Org; // roles carry the production defaults (a new organisation)
  let Q: Org; // roles carry NO data_model.manage yet (an organisation that existed before the migration)
  let customRole: string;

  /** An organisation, its owner, a workspace, the four system roles and one user per role. */
  async function seedOrg(tag: string, withDefaults: boolean): Promise<Org> {
    return asAdmin(async (c) => {
      await c.query('BEGIN');
      const org = (await c.query<{ id: string }>('INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id::text', [`DM ${tag}`, `dm-${RUN_ID}-${tag}`])).rows[0]!.id;
      orgs.push(org);
      const user = async (label: string) =>
        (
          await c.query<{ id: string }>(
            "INSERT INTO core.\"user\" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, $3, 'DM', $4, 'active') RETURNING id::text",
            [org, `${label}-${tag}-dm-${RUN_ID}@dm.invalid`, ARGON, label],
          )
        ).rows[0]!.id;
      const users: Record<string, string> = {};
      for (const label of ['ceo', 'manager', 'manager_revoked', 'venue_manager', 'staff', 'nobody']) users[label] = await user(label);
      const workspace = (
        await c.query<{ id: string }>("INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id::text", [
          org,
          users.ceo,
          `DM ${tag}`,
          `dm-${RUN_ID}-${tag}`,
        ])
      ).rows[0]!.id;
      const roles: Record<string, string> = {};
      for (const [key, flags] of Object.entries(SYSTEM_ROLES)) {
        roles[key] = (await c.query<{ id: string }>('INSERT INTO core.role (organisation_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id::text', [org, key, key])).rows[0]!.id;
        const granted = withDefaults ? flags : flags.filter((f) => f !== PermissionFlag.DATA_MODEL_MANAGE);
        await c.query(
          'INSERT INTO core.role_permission (role_id, permission_id, organisation_id) SELECT $1, p.id, $2 FROM core.permission p WHERE p.key = ANY($3::text[])',
          [roles[key], org, [...granted]],
        );
      }
      const member = async (u: string, roleKey: string) => c.query('INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)', [u, roles[roleKey], org]);
      await member(users.ceo!, 'ceo');
      await member(users.manager!, 'manager');
      await member(users.manager_revoked!, 'manager');
      await member(users.venue_manager!, 'venue_manager');
      await member(users.staff!, STAFF_ROLE_KEY);
      await c.query(
        "INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, p.id, $2, 'revoke' FROM core.permission p WHERE p.key = 'data_model.manage'",
        [users.manager_revoked, org],
      );
      await c.query('COMMIT');
      return { org, workspace, roles, users };
    });
  }

  const holders = (c: Client, org: string) =>
    c
      .query<{ key: string; v: string }>(
        `SELECT r.key, r.permission_version::text AS v FROM core.role r
          WHERE r.organisation_id = $1 AND EXISTS (SELECT 1 FROM core.role_permission rp JOIN core.permission p ON p.id = rp.permission_id
                                                     WHERE rp.role_id = r.id AND p.key = 'data_model.manage')
          ORDER BY r.key`,
        [org],
      )
      .then((r) => r.rows);

  beforeAll(async () => {
    P = await seedOrg('p', true);
    Q = await seedOrg('q', false);
    customRole = await asAdmin(
      async (c) =>
        (
          await c.query<{ id: string }>("INSERT INTO core.role (organisation_id, workspace_id, key, name, is_system) VALUES ($1, $2, $3, 'Data modellers', false) RETURNING id::text", [
            P.org,
            P.workspace,
            `custom_dm_${RUN_ID}`,
          ])
        ).rows[0]!.id,
    );
  });

  afterAll(async () => {
    if (!RUN) return;
    await asAdmin(async (c) => {
      for (const org of orgs) await c.query('DELETE FROM core.organisation WHERE id = $1', [org]).catch(() => undefined);
    });
  });

  // ------------------------------------------------------------------------------------------------------------ DP-1
  it('DP-1 the catalogue holds data_model.manage (resource data_model, action manage) exactly once', async () => {
    const rows = await asAdmin(async (c) => (await c.query("SELECT key, resource, action FROM core.permission WHERE key = 'data_model.manage'")).rows);
    expect(rows).toEqual([{ key: 'data_model.manage', resource: 'data_model', action: 'manage' }]);
  });

  it('DP-1 the production defaults put it on the ceo and manager system roles only', () => {
    const withFlag = Object.entries(SYSTEM_ROLES).filter(([, flags]) => flags.includes(PermissionFlag.DATA_MODEL_MANAGE)).map(([k]) => k).sort();
    expect(withFlag).toEqual(['ceo', 'manager']);
  });

  // ------------------------------------------------------------------------------------------------------------ DP-2
  it('DP-2 why the migration lists organisations through the definer: the owner login with no tenant bound sees no organisation row', async () => {
    const n = await asOwner(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.organisation WHERE id = ANY($1::uuid[])', [[P.org, Q.org]])).rows[0]!.n);
    expect(n).toBe(0);
  });

  it('DP-2 the grant block as the owner-login migration identity: ceo + manager of an existing organisation get it, nobody else; idempotent; down removes it', async () => {
    const r = await asOwner((c) =>
      rolledBack(c, async () => {
        const bind = (org: string) => c.query("SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', '', true)", [org]);
        // Start from the state the migration meets in production: nobody holds the brand-new flag. The test database also
        // holds other spec files' organisations whose fixture roles were built with every PermissionFlag ('all'), so the
        // migration's own down() block clears them first (all inside this rolled-back transaction).
        await c.query(DATA_MODEL_MANAGE_REVOKE_SQL);
        await bind(Q.org);
        const before = await holders(c, Q.org);
        const versions = async () =>
          Object.fromEntries((await c.query<{ key: string; v: string }>('SELECT key, permission_version::text AS v FROM core.role WHERE organisation_id = $1', [Q.org])).rows.map((x) => [x.key, x.v]));
        const v0 = await versions();
        await c.query(DATA_MODEL_MANAGE_GRANT_SQL); // resets the tenant GUCs itself
        await bind(Q.org);
        const after = await holders(c, Q.org);
        const v1 = await versions();
        await c.query(DATA_MODEL_MANAGE_GRANT_SQL); // a re-run grants nothing more and still passes its post-condition
        await bind(Q.org);
        const v2 = await versions();
        await bind(P.org);
        const pHolders = (await holders(c, P.org)).map((h) => h.key);
        await c.query(DATA_MODEL_MANAGE_REVOKE_SQL);
        await bind(Q.org);
        const reverted = await holders(c, Q.org);
        return { before, after: after.map((h) => h.key), v0, v1, v2, pHolders, reverted };
      }),
    );
    expect(r.before).toEqual([]);
    expect(r.after).toEqual(['ceo', 'manager']);
    expect(Number(r.v1.ceo) - Number(r.v0.ceo)).toBe(1);
    expect(Number(r.v1.manager) - Number(r.v0.manager)).toBe(1);
    expect(r.v1.venue_manager).toBe(r.v0.venue_manager);
    expect(r.v1[STAFF_ROLE_KEY]).toBe(r.v0[STAFF_ROLE_KEY]);
    expect(r.v2).toEqual(r.v1);
    expect(r.pHolders).toEqual(['ceo', 'manager']);
    expect(r.reverted).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------------------ DP-3
  describe('DP-3 layer 2 against PostgreSQL (DataModelAuthorityService over the runtime login)', () => {
    let ds: DataSource;
    let service: DataModelAuthorityService;

    beforeAll(async () => {
      ds = new DataSource({ type: 'postgres', url: OWNER_URL, entities: [], synchronize: false, logging: false, extra: { max: 2 } });
      await ds.initialize();
      const permissions = new PermissionsService({} as TenantContextService);
      // The primary DataSource (property-injected in the app): userHasPermissionTx takes its one-statement path.
      Object.assign(permissions, { primaryDataSource: ds });
      service = new DataModelAuthorityService(permissions);
    });
    afterAll(async () => {
      await ds?.destroy();
    });

    const ctxFor = (o: Org, label: string, over: Partial<AuthContext> = {}): AuthContext => ({
      organisationId: o.org,
      workspaceId: o.workspace,
      userId: o.users[label]!,
      role: label,
      ...over,
    });
    /** Run the check in a transaction bound the way TenantContextService binds a request. */
    const check = (ctx: AuthContext, bindOrg = ctx.organisationId, bindWorkspace = ctx.workspaceId) =>
      ds
        .transaction(async (m) => {
          await m.query(BIND_SQL, [bindOrg ?? '', bindWorkspace ?? '', ctx.userId, ctx.role]);
          await service.assertCanManageDataModelTx(m, ctx);
          return 'allowed';
        })
        .catch((e: unknown) => (e instanceof DataModelPermissionDeniedException ? `403:${(e.getResponse() as { code: string }).code}` : `error:${String(e)}`));

    it('DP-3 the CEO and a Manager (system role defaults) may change the data model', async () => {
      expect(await check(ctxFor(P, 'ceo'))).toBe('allowed');
      expect(await check(ctxFor(P, 'manager'))).toBe('allowed');
    });

    it('DP-3 ABUSE: Venue Manager, Staff and a user with no role are refused (403 PERMISSION_DENIED)', async () => {
      expect(await check(ctxFor(P, 'venue_manager'))).toBe('403:PERMISSION_DENIED');
      expect(await check(ctxFor(P, 'staff'))).toBe('403:PERMISSION_DENIED');
      expect(await check(ctxFor(P, 'nobody'))).toBe('403:PERMISSION_DENIED');
    });

    it('DP-3 ABUSE: a Manager with a per-user revoke override is refused (overrides win over roles)', async () => {
      expect(await check(ctxFor(P, 'manager_revoked'))).toBe('403:PERMISSION_DENIED');
    });

    it('DP-3 ABUSE: an organisation that has not run the migration yet (Q: roles without the flag) is refused', async () => {
      expect(await check(ctxFor(Q, 'ceo'))).toBe('403:PERMISSION_DENIED');
    });

    it('DP-3 ABUSE: a CEO whose transaction is bound to another organisation is refused (RLS hides the grants)', async () => {
      expect(await check(ctxFor(P, 'ceo'), Q.org, Q.workspace)).toBe('403:PERMISSION_DENIED');
    });

    it('DP-3 ABUSE: an Admin Inspect session of the CEO and a worker context are refused before any query', async () => {
      expect(await check(ctxFor(P, 'ceo', { inspectedBy: P.users.nobody }))).toBe('403:PERMISSION_DENIED');
      expect(await check(ctxFor(P, 'ceo', { actorType: 'worker' }))).toBe('403:PERMISSION_DENIED');
      expect(await check(ctxFor(P, 'ceo', { workspaceId: null }))).toBe('403:PERMISSION_DENIED');
    });
  });

  // ------------------------------------------------------------------------------------------------------------ DP-4
  it('DP-4 ABUSE: a custom workspace-member role can never carry data_model.manage (allowlist trigger, 23514), even as the superuser', async () => {
    const asRuntime = await asOwner((c) =>
      rolledBack(c, async () => {
        await c.query(BIND_SQL, [P.org, P.workspace, P.users.ceo, 'ceo']);
        return attempt(
          c,
          "INSERT INTO core.role_permission (role_id, permission_id, organisation_id) SELECT $1, p.id, $2 FROM core.permission p WHERE p.key = 'data_model.manage'",
          [customRole, P.org],
        );
      }),
    );
    const asSuper = await asAdmin((c) =>
      rolledBack(c, () =>
        attempt(c, "INSERT INTO core.role_permission (role_id, permission_id, organisation_id) SELECT $1, p.id, $2 FROM core.permission p WHERE p.key = 'data_model.manage'", [
          customRole,
          P.org,
        ]),
      ),
    );
    expect({ asRuntime, asSuper }).toEqual({ asRuntime: '23514', asSuper: '23514' });
    // The trigger is still the reviewed one: only the three read-only flags pass for a member role.
    const body = await asAdmin(
      async (c) => (await c.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE oid = 'core.enforce_member_role_permission_allowlist()'::regprocedure")).rows[0]!.src,
    );
    expect(body).toContain("ARRAY['staff.view', 'venue.view', 'schedule.view']");
  });
});
