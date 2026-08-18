import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staff, manager and venue foundation (rab-workforce-architecture.md §11
 * "PEOPLE"/"VENUES", §5.7). Every table here is only ever touched after a
 * session is established (no pre-auth lookups land in these tables the way
 * `user`/`organisation` do), so unlike IdentitySchema, everything here is
 * FORCEd — no exceptions.
 */
export class OperationalSchema1786665900000 implements MigrationInterface {
  name = 'OperationalSchema1786665900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.staff_profile (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id         uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id                 uuid NOT NULL UNIQUE REFERENCES core."user"(id) ON DELETE CASCADE,
        staff_ref               text NOT NULL,
        date_of_birth           date,
        employment_status       text NOT NULL DEFAULT 'pending_compliance'
                                CHECK (employment_status IN ('pending_compliance','active','inactive','suspended')),
        start_date              date,
        default_pay_rate_pence  bigint NOT NULL DEFAULT 0 CHECK (default_pay_rate_pence >= 0),
        notes                   text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organisation_id, staff_ref)
      );
      CREATE INDEX staff_profile_org_status_idx ON core.staff_profile (organisation_id, employment_status);
    `);
    await queryRunner.query(`ALTER TABLE core.staff_profile ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.staff_profile FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY staff_profile_tenant ON core.staff_profile
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.manager_profile (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id           uuid NOT NULL UNIQUE REFERENCES core."user"(id) ON DELETE CASCADE,
        type              text NOT NULL CHECK (type IN ('internal','venue')),
        job_title         text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX manager_profile_org_type_idx ON core.manager_profile (organisation_id, type);
    `);
    await queryRunner.query(`ALTER TABLE core.manager_profile ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_profile FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_tenant ON core.manager_profile
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.venue (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id       uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        name                  text NOT NULL,
        client_name           text,
        type                  text NOT NULL DEFAULT 'other'
                              CHECK (type IN ('hotel','restaurant','warehouse','event','other')),
        address               jsonb NOT NULL DEFAULT '{}',
        lat                   numeric(9,6),
        lng                   numeric(9,6),
        geofence_radius_m     int NOT NULL DEFAULT 200,
        enforce_geofence      boolean NOT NULL DEFAULT false,
        contact               jsonb NOT NULL DEFAULT '{}',
        instructions          text,
        uniform               text,
        check_in_instructions text,
        parking               text,
        access_notes          text,
        break_paid            boolean NOT NULL DEFAULT false,
        status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX venue_org_status_idx ON core.venue (organisation_id, status);
    `);
    await queryRunner.query(`ALTER TABLE core.venue ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.venue FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY venue_tenant ON core.venue
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // Which venue managers can see which venues — drives future VENUE_MANAGER
    // row-level scoping (rab-workforce-architecture.md §7). Not yet consumed
    // by a policy on another table (no venue-scoped data exists yet beyond
    // venue itself); wiring lands with the module that needs it.
    await queryRunner.query(`
      CREATE TABLE core.manager_venue (
        organisation_id       uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        manager_profile_id    uuid NOT NULL REFERENCES core.manager_profile(id) ON DELETE CASCADE,
        venue_id              uuid NOT NULL REFERENCES core.venue(id) ON DELETE CASCADE,
        created_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (manager_profile_id, venue_id)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.manager_venue ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_venue FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY manager_venue_tenant ON core.manager_venue
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.manager_venue`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.venue`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.manager_profile`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.staff_profile`);
  }
}
