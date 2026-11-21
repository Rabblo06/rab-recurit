import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lane D (milestone M1; DRAFT — owner SQL review first): the four staff-document permissions.
 *
 *  1. Adds `staff_document.view`, `staff_document.manage`, `staff_document.configure` and `staff_document.own` to the
 *     permission catalogue (`core.permission`; permission-catalogue.spec: every PermissionFlag ships with a migration).
 *  2. Grants defaults to the organisation-level SYSTEM roles of every existing organisation, bumping each changed role's
 *     `permission_version` (cached authorisation snapshots die) — the same mechanism as AiAgentsPermission1786721030000:
 *       manager (Initial + Internal Managers): view, manage, configure;
 *       staff: own.
 *     ceo / venue_manager get none. New organisations get the same from ROLE_DEFS / STAFF_ROLE_PERMISSIONS.
 *     OWNER DECISION (permission rule): these defaults are the lane's proposal, not an approved rule.
 *
 * A flag is never sufficient on its own: StaffDocumentService (layer 2) and the RLS predicates of StaffDocumentSchema1786722300000
 * (layers 4–5) also require a non-venue manager of the bound workspace (view / manage), a non-venue manager of the
 * organisation (configure), or the document's own staff member (own). Catalogue and role grants only.
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786722310000: Readonly<
  Record<string, readonly string[]>
> = {
  manager: [
    'staff_document.view',
    'staff_document.manage',
    'staff_document.configure',
  ],
  staff: ['staff_document.own'],
};

const PERMISSIONS: ReadonlyArray<{ key: string; action: string }> = [
  { key: 'staff_document.view', action: 'view' },
  { key: 'staff_document.manage', action: 'manage' },
  { key: 'staff_document.configure', action: 'configure' },
  { key: 'staff_document.own', action: 'own' },
];

export class StaffDocumentPermissions1786722310000 implements MigrationInterface {
  name = 'StaffDocumentPermissions1786722310000';

  async up(runner: QueryRunner): Promise<void> {
    for (const p of PERMISSIONS) {
      await runner.query(
        `INSERT INTO core.permission (key, resource, action) VALUES ($1, 'staff_document', $2) ON CONFLICT (key) DO NOTHING`,
        [p.key, p.action],
      );
    }
    for (const [roleKey, keys] of Object.entries(
      SYSTEM_ROLE_DEFAULT_ADDITIONS_1786722310000,
    )) {
      await runner.query(
        `
      DO $grant$
      DECLARE o record; v_perms uuid[]; v_role text := $role$${roleKey}$role$; v_keys text[] := ARRAY[${keys.map((k) => `'${k}'`).join(', ')}]::text[];
      BEGIN
        SELECT array_agg(id) INTO v_perms FROM core.permission WHERE key = ANY (v_keys);
        IF coalesce(cardinality(v_perms), 0) <> cardinality(v_keys) THEN RAISE EXCEPTION 'StaffDocumentPermissions1786722310000: permission missing for role %', v_role; END IF;
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, p.id, r.organisation_id FROM core.role r CROSS JOIN unnest(v_perms) AS p(id)
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key = v_role
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = p.id)
            RETURNING role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT DISTINCT role_id FROM ins);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $grant$;`,
      );
    }
    // Post-condition: four flags exist; nobody but the listed system roles holds them (no workspace / custom role).
    const [check] = (await runner.query(
      `SELECT (SELECT count(*) FROM core.permission WHERE key LIKE 'staff_document.%')::int AS perms,
              (SELECT count(*) FROM core.role_permission rp JOIN core.role r ON r.id = rp.role_id JOIN core.permission p ON p.id = rp.permission_id
                WHERE p.key LIKE 'staff_document.%'
                  AND NOT (r.is_system AND ((r.key = 'manager' AND p.key IN ('staff_document.view', 'staff_document.manage', 'staff_document.configure'))
                                         OR (r.key = 'staff' AND p.key = 'staff_document.own'))))::int AS unexpected`,
    )) as Array<{ perms: number; unexpected: number }>;
    if (check.perms !== 4 || check.unexpected !== 0)
      throw new Error(
        `${this.name}: post-condition failed ${JSON.stringify(check)}`,
      );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $revoke$
      DECLARE o record;
      BEGIN
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH del AS (
            DELETE FROM core.role_permission rp USING core.role r, core.permission p
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key LIKE 'staff_document.%' AND r.organisation_id = o.id
            RETURNING rp.role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT DISTINCT role_id FROM del);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $revoke$;`);
    // user_permission_override rows (if any) cascade from core.permission (IdentitySchema1786665800000).
    await runner.query(
      `DELETE FROM core.permission WHERE key LIKE 'staff_document.%'`,
    );
  }
}
