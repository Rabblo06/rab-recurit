import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Batch 3 (S7 follow-up, Agent 9, coordinator decision 2026-10-26): `core.ai_usage.outcome` gains `waiting_for_input`.
 *
 * A turn that PAUSES on `ask_question` / `request_form` books its tokens and estimated cost once, at the pause, in the same
 * compare-and-set transaction as a terminal turn (the cost must still be counted against both meters and the per-user
 * seed). Before this migration the ledger CHECK had no value for that state, so a paused turn was recorded `completed`,
 * which made usage reports say a question was answered when it was still waiting for the person. The answer's
 * continuation is a NEW turn with its own ledger row, so nothing is booked twice.
 *
 * Only the CHECK changes: no column, no grant, no policy. FORCE RLS, the owner, the insert-only grants (no UPDATE / DELETE
 * / TRUNCATE for `crewflow_app`) and no BYPASSRLS are re-asserted below. `down()` refuses (fail closed, read with
 * `row_security = off` so a role under RLS gets an error instead of a filtered zero) while any `waiting_for_input` row
 * exists — the ledger is insert-only, so such rows can't be rewritten to fit the narrower CHECK. Not production-approved (N1).
 */
const TABLE = 'core.ai_usage';
const OUTCOMES_7A = `'completed', 'failed', 'cancelled'`;
const OUTCOMES_B3 = `'completed', 'failed', 'cancelled', 'waiting_for_input'`;

export class AiUsageWaitingOutcome1786721080000 implements MigrationInterface {
  name = 'AiUsageWaitingOutcome1786721080000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ai_usage_outcome_check;`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_usage_outcome_check CHECK (outcome IN (${OUTCOMES_B3}));`);
    await this.verify(runner);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL row_security = off;`);
    const [row] = (await runner.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE outcome = 'waiting_for_input'`)) as Array<{ n: number }>;
    if ((row?.n ?? 0) > 0) throw new Error(`${this.name}: refusing down() — ${row!.n} ledger row(s) are 'waiting_for_input' (insert-only; cannot narrow the CHECK)`);
    await runner.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ai_usage_outcome_check;`);
    await runner.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ai_usage_outcome_check CHECK (outcome IN (${OUTCOMES_7A}));`);
    await this.verify(runner);
  }

  private async verify(runner: QueryRunner): Promise<void> {
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow'
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname = 'ai_usage') AS forced,
         has_any_column_privilege('crewflow_app', '${TABLE}', 'UPDATE') AS app_update,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS app_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS app_truncate,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, boolean>>;
    if (check.forced !== true || check.app_update || check.app_delete || check.app_truncate || check.app_bypass) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }
}
