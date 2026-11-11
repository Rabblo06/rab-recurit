import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index fix IDX-A (owner-approved 2026-11-06; docs/plans/index-fix/current/PROPOSAL.md §3): the per-scope dispatch claims.
 *
 * The email and push claims (rab-worker email-dispatch.job.ts, push-dispatch.job.ts) run once per organisation on every
 * sweep. Their SQL has no organisation
 * predicate: RLS adds `organisation_id = core.current_org()` (FORCE; the owner login is bound by it). The only status indexes
 * were `(status, created_at) WHERE status IN ('PENDING','RETRY')`, which cannot serve the claim's
 * `PENDING OR QUEUED(stale) OR PROCESSING(lease) OR RETRY(stale)` predicate together with the tenant filter, so EXPLAIN as
 * crewflow_owner showed a Seq Scan of the WHOLE outbox for every organisation (~95 ms per organisation at 200k rows: ~19 s
 * per email sweep, longer than the 2 s push interval).
 *
 * Each index leads with organisation_id (the RLS Index Cond; current_org() is STABLE SQL and inlines), then created_at (the
 * claim's ORDER BY, so LIMIT stops early). The partial predicate is the union of the statuses every arm of the claim's OR
 * names; the index holds only in-flight rows (terminal rows leave it). Measured (PG16 + PG18, 200k rows, as crewflow_owner):
 * the email and push claims become an ordered Index Scan (~95 ms → ~0.3 ms per organisation).
 * The realtime claim is deliberately NOT indexed here (owner decision 2026-11-06, deferred): its first arm nests
 * `status IN ('pending', 'retry')`, which PostgreSQL's predicate prover does not see through, so a
 * `(organisation_id, created_at)` partial index was only usable as a bitmap (no measured gain). It needs the claim SQL to
 * also state `status IN ('pending', 'retry', 'processing')` first — a separate, owner-gated change.
 * WORKER_CLAIM_MODE=global needs nothing extra: its scan is core.worker_dispatch_pointer, and its per-scope step adds
 * `AND id = ANY($ids)` (PK); its per_scope reconciliation sweep uses these indexes.
 *
 * `transaction = false` → CREATE INDEX CONCURRENTLY (the outbox writers are never blocked). Failure handling as in
 * AuditLogOrganisationActionIndex1786720110000: an INVALID leftover of a failed concurrent build is dropped (CONCURRENTLY)
 * and rebuilt; the build must end VALID or the migration throws (and stays unrecorded, so the next run retries); when
 * TypeORM forces a transaction (migration:revert) the plain locking form is used. Listed in NON_TRANSACTIONAL_MIGRATIONS
 * (upgrade-failure-policy.ts). Run scripts/concurrent-migration-preflight.sql first.
 * Not in production-migration-approval.ts: production approval is a separate owner gate.
 */
const INDEXES: ReadonlyArray<{ name: string; definition: string }> = Object.freeze([
  {
    name: 'email_outbox_claim_idx',
    definition: `ON core.email_outbox (organisation_id, created_at) WHERE status IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRY')`,
  },
  {
    name: 'push_delivery_claim_idx',
    definition: `ON core.push_delivery (organisation_id, created_at) WHERE status IN ('PENDING', 'PROCESSING', 'RETRY')`,
  },
]);
/** Owner of core.email_outbox / core.push_delivery. */
const TABLE_OWNER = 'crewflow';

export class OutboxClaimIndexes1786721440000 implements MigrationInterface {
  name = 'OutboxClaimIndexes1786721440000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    await queryRunner.query(`SET lock_timeout = '60s'`);
    try {
      for (const index of INDEXES) {
        if ((await this.state(queryRunner, index.name)) === 'INVALID') await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${index.name}`);
        if ((await this.state(queryRunner, index.name)) === 'ABSENT') {
          await queryRunner.query(`CREATE INDEX ${cc}IF NOT EXISTS ${index.name} ${index.definition}`);
        }
        if ((await this.state(queryRunner, index.name)) !== 'VALID') throw new Error(`${this.name}: ${index.name} is not valid after the build`);
      }
    } finally {
      await queryRunner.query('RESET lock_timeout');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    for (const index of [...INDEXES].reverse()) await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${index.name}`);
  }

  private async state(queryRunner: QueryRunner, name: string): Promise<'ABSENT' | 'VALID' | 'INVALID'> {
    const rows: Array<{ valid: boolean; ready: boolean }> = await queryRunner.query(
      `SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname = $1`,
      [name],
    );
    if (rows.length === 0) return 'ABSENT';
    return rows[0]!.valid && rows[0]!.ready ? 'VALID' : 'INVALID';
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_has_role(current_user, $1, 'USAGE') AS ok`, [TABLE_OWNER]);
    if (!ok) throw new Error(`${this.name} must run as ${TABLE_OWNER} or the migration identity (owner of the outbox tables)`);
  }
}
