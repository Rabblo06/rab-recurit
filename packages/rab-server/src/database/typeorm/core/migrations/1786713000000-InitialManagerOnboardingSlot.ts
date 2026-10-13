import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9 gap review, item 2 (owner-approved, corrected design) — distinguishes an organisation's
 * ONE bootstrap "Initial Manager" onboarding slot from its ordinary, unlimited additional
 * Internal Managers (added via the existing, unmodified `POST /managers` flow).
 *
 * The owner's first proposed index (`UNIQUE (organisation_id) WHERE type = 'internal'`) was
 * rejected and correctly so: live inspection of the local/test database at review time found
 * organisations with 6–7 `type = 'internal'` rows each (ordinary Add-Manager usage, unrelated to
 * the Initial Manager bootstrap flow) — that index would have failed to even CREATE against
 * existing data, and would have permanently blocked Manager B/C/D for every organisation. This
 * migration instead adds a marker so the uniqueness constraint only ever applies to the ONE row
 * that is genuinely the current Initial Manager.
 *
 * `is_initial_manager`: set exactly once, immediately after `inviteInitialManager`'s own
 * `createWithin()` call, in the SAME transaction — never a client-settable DTO field (no
 * mass-assignment surface; `CreateManagerDto`/`InviteInitialManagerDto` gain no new field).
 * `superseded_at`: set by the new replacement flow when a never-activated Initial Manager's
 * invitation has genuinely exhausted its recovery options — the row is NEVER deleted, only
 * marked, preserving its history and audit trail.
 *
 * No backfill: every existing row defaults `is_initial_manager = false`. Verified safe by direct
 * inspection before writing this migration — this feature has never been deployed to production,
 * and every existing `type = 'internal'` row in any reachable database is disposable integration-
 * test fixture data (11,977 rows across repeated local test runs this session, none of which
 * "must retain a bootstrap identity"). Every NEW organisation invited going forward tags its
 * genuine Initial Manager correctly from the moment this ships.
 *
 * RLS implications: none. `manager_profile_tenant`'s existing policy governs row visibility by
 * `organisation_id`/platform-admin claim; neither new column is referenced by it, so no policy
 * change is needed. `core.manager_profile` is owned by `crewflow` (confirmed this session) — this
 * migration runs on the ordinary migration connection, no superuser connection required.
 */
export class InitialManagerOnboardingSlot1786713000000 implements MigrationInterface {
  name = 'InitialManagerOnboardingSlot1786713000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.manager_profile
        ADD COLUMN is_initial_manager boolean NOT NULL DEFAULT false,
        ADD COLUMN superseded_at timestamptz NULL;
    `);

    // Partial — only ever constrains the ONE current Initial Manager slot per organisation.
    // An ordinary additional Internal Manager (is_initial_manager = false, the default) is
    // entirely outside this index's predicate and never contends with it.
    await queryRunner.query(`
      CREATE UNIQUE INDEX manager_profile_one_current_initial_manager
        ON core.manager_profile (organisation_id)
        WHERE type = 'internal' AND is_initial_manager = true AND superseded_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS core.manager_profile_one_current_initial_manager;`);
    await queryRunner.query(`
      ALTER TABLE core.manager_profile
        DROP COLUMN IF EXISTS superseded_at,
        DROP COLUMN IF EXISTS is_initial_manager;
    `);
  }
}
