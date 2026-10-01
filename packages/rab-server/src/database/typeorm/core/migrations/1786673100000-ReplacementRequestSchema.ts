import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.replacement_request` — the durable state machine behind the new
 * replacement-staff automation (rab-worker migration). One row per DECLINED
 * or EXPIRED offer that still leaves its shift short-staffed. The worker
 * (`queues/rab-offers/replacement-staff.job.ts`) only ever creates rows and
 * fills `candidates_snapshot`/flips to `awaiting_approval` — it NEVER sends
 * an offer itself. Only a manager's authenticated `POST .../approve` (via
 * `ReplacementRequestController`, reusing `OfferService.send()` unchanged)
 * can move a row to `offer_sent`.
 *
 * `declined_shift_assignment_id UNIQUE` is the multi-replica idempotency
 * mechanism: two worker replicas (or two overlapping ticks) racing to
 * process the same decline both attempt this INSERT; the loser's insert
 * hits the unique violation and is treated as "another worker already
 * claimed this," never as an error — see that job's own doc comment.
 *
 * `candidates_snapshot` is a point-in-time jsonb snapshot for the manager's
 * review UI ONLY — approval re-validates the specific selected candidate
 * fresh from the live tables before ever calling `OfferService.send()`,
 * never trusts this blob as authorization.
 *
 * RLS mirrors `ReportSchema1786672200000`'s own shift-joined shape exactly
 * (same reasoning: a Venue Manager needs to see a replacement request for a
 * shift at their own venue even if `workspace_id` doesn't match their own).
 */
export class ReplacementRequestSchema1786673100000 implements MigrationInterface {
  name = 'ReplacementRequestSchema1786673100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.replacement_request (
        id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id               uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id                  uuid REFERENCES core.manager_workspace(id),
        shift_id                      uuid NOT NULL REFERENCES core.shift(id) ON DELETE CASCADE,
        declined_shift_assignment_id  uuid NOT NULL UNIQUE REFERENCES core.shift_assignment(id) ON DELETE CASCADE,
        declined_offer_id             uuid REFERENCES core.job_offer(id) ON DELETE SET NULL,
        status                        text NOT NULL DEFAULT 'awaiting_approval'
                                       CHECK (status IN ('awaiting_approval', 'no_candidates', 'approved', 'rejected', 'offer_sent', 'cancelled')),
        candidates_snapshot           jsonb NOT NULL DEFAULT '[]',
        selected_staff_profile_id     uuid REFERENCES core.staff_profile(id) ON DELETE SET NULL,
        resulting_offer_id            uuid REFERENCES core.job_offer(id) ON DELETE SET NULL,
        approved_by                   uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        approved_at                   timestamptz,
        rejected_by                   uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        rejected_at                   timestamptz,
        notified_user_id              uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        created_at                    timestamptz NOT NULL DEFAULT now(),
        updated_at                    timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX replacement_request_shift_idx ON core.replacement_request (shift_id);`);
    await queryRunner.query(`CREATE INDEX replacement_request_status_idx ON core.replacement_request (status);`);

    await queryRunner.query(`ALTER TABLE core.replacement_request ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.replacement_request FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY replacement_request_tenant ON core.replacement_request
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = replacement_request.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.replacement_request`);
  }
}
