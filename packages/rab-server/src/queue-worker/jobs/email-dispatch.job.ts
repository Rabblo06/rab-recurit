import { DataSource } from 'typeorm';

const BATCH_SIZE = 50;

interface ClaimedRow {
  id: string;
  organisation_id: string;
}

export interface EmailDispatchResult {
  claimed: number;
  published: number;
}

/**
 * The dispatcher half of the transactional outbox — see
 * `email-outbox.entity.ts`'s doc comment for the durability property this
 * provides. Runs on a short interval (see `main.ts`), independent of the
 * request-time "fast path" publish attempt in `EmailOutboxService.
 * tryFastPublish` — that attempt is allowed to fail silently (a crash, a
 * momentary Redis blip) precisely BECAUSE this sweep exists as the real
 * backstop. A row can only ever be lost if BOTH the fast-path publish and
 * every subsequent dispatch cycle fail, which durability-wise is
 * indistinguishable from Redis itself being down — not a gap this design
 * claims to cover (queue delivery to Redis itself is out of scope; the
 * durable row surviving an API-process crash is what's actually promised).
 *
 * Connects as `rab_owner` (`DATABASE_URL_UNPOOLED`) — the SAME
 * cross-org-maintenance convention `account-invite-cleanup.job.ts` already
 * established for exactly this class of work: a genuinely cross-tenant
 * sweep that has no single `organisation_id` to bind context to ahead of
 * time. This is the ONE place in the whole email-outbox design that uses
 * owner-level access — deliberately narrow (claim + read `organisation_id`
 * only, never rendered content, never a token) and never reused by the
 * worker's own per-job processing, which binds proper `rab_app` tenant
 * context instead (see `email-send.processor.ts`).
 */
export async function runEmailDispatchCycle(dataSource: DataSource, publish: (emailOutboxId: string, organisationId: string) => Promise<void>): Promise<EmailDispatchResult> {
  return dataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_email_dispatch'))`);

    // `email_outbox` IS FORCE'd (unlike `account_invite`) — this owner
    // connection needs the same DISABLE/ENABLE bracket the cleanup job
    // already established for FORCE'd cross-org reads, not a blanket
    // exemption on the table itself (no pre-auth path needs one).
    await manager.query(`ALTER TABLE core.email_outbox DISABLE ROW LEVEL SECURITY;`);
    let claimed: ClaimedRow[];
    try {
      // SELECT-then-UPDATE (no RETURNING), same documented reason as the
      // cleanup job: `manager.query()` returns a `[rows, rowCount]` TUPLE
      // for UPDATE, not the bare rows array a SELECT returns.
      // Also re-claims a row stuck QUEUED for >2 minutes — the one case a
      // failed `publish()` call below (this cycle or an earlier one) can't
      // self-heal from, since a row only ever leaves PENDING once. Without
      // this, a single failed publish would strand a row forever instead
      // of the next cycle simply trying again.
      claimed = await manager.query<ClaimedRow[]>(
        `SELECT id, organisation_id FROM core.email_outbox
          WHERE status = 'PENDING' OR (status = 'QUEUED' AND queued_at < now() - interval '2 minutes')
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );
      if (claimed.length > 0) {
        await manager.query(
          `UPDATE core.email_outbox SET status = 'QUEUED', queued_at = now() WHERE id = ANY($1::uuid[])`,
          [claimed.map((row) => row.id)],
        );
      }
    } finally {
      await manager.query(`ALTER TABLE core.email_outbox ENABLE ROW LEVEL SECURITY;`);
    }

    let published = 0;
    for (const row of claimed) {
      try {
        await publish(row.id, row.organisation_id);
        published += 1;
      } catch (error) {
        // Left QUEUED — the staleness re-claim above picks this back up in
        // ~2 minutes if it's still stuck then. Logged, not thrown — one
        // queue outage must not stop the rest of this batch from publishing.
        // eslint-disable-next-line no-console
        console.error(`email dispatch: failed to publish outbox row ${row.id}:`, error);
      }
    }

    return { claimed: claimed.length, published };
  });
}
