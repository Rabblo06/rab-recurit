import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Scheduling foundation (rab-workforce-architecture.md §11 "SCHEDULING",
 * §5.7, §8.4). Everything here is only ever touched post-auth, so every
 * table is FORCEd — no exceptions.
 *
 * `staffing_request_id` on `shift` is intentionally omitted — venue
 * staffing requests are a later phase; the column and its FK land in the
 * migration that creates `staffing_request`, not before.
 *
 * `shift_assignment.period` is a denormalised `tstzrange` snapshot of its
 * shift's `[starts_at, ends_at)` window, set by the application at
 * assignment-creation time — not kept in sync by trigger yet (shift-time
 * edits after assignment aren't built in this pass; a trigger to re-sync
 * `period` on `shift` UPDATE is a follow-up once they are). It exists
 * purely so the GiST exclusion constraint below can enforce "no
 * double-booking" without a join back to `shift` on every write.
 */
export class SchedulingSchema1786666000000 implements MigrationInterface {
  name = 'SchedulingSchema1786666000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.job_role (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id     uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        name                text NOT NULL,
        default_rate_pence  bigint NOT NULL DEFAULT 0 CHECK (default_rate_pence >= 0),
        created_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organisation_id, name)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.job_role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.job_role FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY job_role_tenant ON core.job_role
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.venue_role_rate (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id       uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        venue_id              uuid NOT NULL REFERENCES core.venue(id) ON DELETE CASCADE,
        job_role_id           uuid NOT NULL REFERENCES core.job_role(id) ON DELETE CASCADE,
        pay_rate_pence        bigint NOT NULL CHECK (pay_rate_pence >= 0),
        charge_rate_pence     bigint NOT NULL DEFAULT 0 CHECK (charge_rate_pence >= 0),
        overtime_multiplier   numeric(3,2) NOT NULL DEFAULT 1.0,
        effective_from        date NOT NULL DEFAULT CURRENT_DATE,
        effective_to          date,
        created_at            timestamptz NOT NULL DEFAULT now(),
        UNIQUE (venue_id, job_role_id, effective_from)
      );
      CREATE INDEX venue_role_rate_venue_role_idx ON core.venue_role_rate (venue_id, job_role_id);
    `);
    await queryRunner.query(`ALTER TABLE core.venue_role_rate ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.venue_role_rate FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY venue_role_rate_tenant ON core.venue_role_rate
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.shift (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id       uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        venue_id              uuid NOT NULL REFERENCES core.venue(id) ON DELETE RESTRICT,
        job_role_id           uuid NOT NULL REFERENCES core.job_role(id) ON DELETE RESTRICT,
        starts_at             timestamptz NOT NULL,
        ends_at               timestamptz NOT NULL,
        break_minutes         int NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
        required_count        int NOT NULL CHECK (required_count > 0),
        filled_count           int NOT NULL DEFAULT 0 CHECK (filled_count >= 0),
        pay_rate_pence        bigint NOT NULL CHECK (pay_rate_pence >= 0),
        charge_rate_pence     bigint NOT NULL DEFAULT 0 CHECK (charge_rate_pence >= 0),
        notes                 text,
        status                text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','open','offered','partially_filled',
                                                 'fully_filled','confirmed','in_progress',
                                                 'completed','cancelled')),
        recurrence_group_id   uuid,
        created_by            uuid NOT NULL REFERENCES core."user"(id),
        published_at          timestamptz,
        cancelled_reason      text,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT shift_time_order CHECK (ends_at > starts_at),
        CONSTRAINT shift_capacity_bound CHECK (filled_count <= required_count)
      );
      CREATE INDEX shift_org_starts_idx ON core.shift (organisation_id, starts_at DESC);
      CREATE INDEX shift_venue_starts_idx ON core.shift (venue_id, starts_at DESC);
      CREATE INDEX shift_open_status_idx ON core.shift (status)
        WHERE status IN ('open','offered','partially_filled');
    `);
    await queryRunner.query(`ALTER TABLE core.shift ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.shift FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY shift_tenant ON core.shift
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // btree_gist (InitSchema migration) makes the `=` operator usable
    // inside a GiST exclusion constraint alongside the range overlap `&&`
    // operator below — the actual "no double-booking" invariant.
    await queryRunner.query(`
      CREATE TABLE core.shift_assignment (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id           uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        shift_id                  uuid NOT NULL REFERENCES core.shift(id) ON DELETE CASCADE,
        staff_profile_id          uuid NOT NULL REFERENCES core.staff_profile(id) ON DELETE CASCADE,
        status                    text NOT NULL DEFAULT 'offered'
                                  CHECK (status IN ('offered','confirmed','declined','withdrawn',
                                                     'cancelled','no_show','completed')),
        pay_rate_snapshot_pence   bigint NOT NULL CHECK (pay_rate_snapshot_pence >= 0),
        assigned_by               uuid REFERENCES core."user"(id),
        confirmed_at              timestamptz,
        period                    tstzrange NOT NULL,
        created_at                timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shift_id, staff_profile_id)
      );
      CREATE INDEX shift_assignment_staff_status_idx ON core.shift_assignment (staff_profile_id, status);
      ALTER TABLE core.shift_assignment
        ADD CONSTRAINT shift_assignment_no_double_booking
        EXCLUDE USING gist (staff_profile_id WITH =, period WITH &&)
        WHERE (status IN ('confirmed','completed'));
    `);
    await queryRunner.query(`ALTER TABLE core.shift_assignment ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.shift_assignment FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY shift_assignment_tenant ON core.shift_assignment
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.job_offer (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id       uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        shift_assignment_id   uuid NOT NULL UNIQUE REFERENCES core.shift_assignment(id) ON DELETE CASCADE,
        staff_profile_id      uuid NOT NULL REFERENCES core.staff_profile(id) ON DELETE CASCADE,
        status                text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','accepted','declined','expired','withdrawn')),
        sent_at               timestamptz NOT NULL DEFAULT now(),
        expires_at            timestamptz NOT NULL,
        responded_at          timestamptz,
        decline_reason        text,
        estimated_pay_pence   bigint NOT NULL CHECK (estimated_pay_pence >= 0),
        created_at            timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX job_offer_staff_status_idx ON core.job_offer (staff_profile_id, status);
      CREATE INDEX job_offer_pending_expiry_idx ON core.job_offer (expires_at) WHERE status = 'pending';
    `);
    await queryRunner.query(`ALTER TABLE core.job_offer ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.job_offer FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY job_offer_tenant ON core.job_offer
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.job_offer`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.shift_assignment`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.shift`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.venue_role_rate`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.job_role`);
  }
}
