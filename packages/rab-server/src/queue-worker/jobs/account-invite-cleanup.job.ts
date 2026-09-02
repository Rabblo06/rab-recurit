import { DataSource } from 'typeorm';

const BATCH_SIZE = 50;

interface ExpireCandidate {
  id: string;
  organisation_id: string;
}

interface CleanupCandidate {
  id: string;
  organisation_id: string;
}

export interface AccountInviteCleanupResult {
  expired: number;
  deleted: number;
  retained: number;
}

/**
 * The one and only application-level scheduled job in this codebase (no
 * existing job/queue architecture was found to reuse — `bullmq` is a
 * dependency, but nothing had ever registered a real processor before
 * this). Runs on a fixed interval from `queue-worker/main.ts`. Two phases,
 * both idempotent and safe to re-run at any time since every action is
 * conditioned on current DB state, never on "have I already processed
 * this":
 *
 *  1. Expire — any account whose 3rd (final) invitation attempt has passed
 *     its `expires_at` with no activation moves `user.status` from
 *     'invited' to 'invite_expired'. Purely bookkeeping/display — security
 *     enforcement (login, activation) never depends on this having run yet;
 *     it always checks the live `account_invite` row directly. See
 *     `AccountInviteService`'s own doc comment.
 *  2. Cleanup — any account that's been 'invite_expired' for at least the
 *     7-day grace period (`account_invite.cleanup_at`, set at issue time
 *     for the 3rd attempt only) is individually checked against every
 *     condition the spec requires before a hard delete is even considered:
 *     still not ACTIVE, invitation limit exhausted, grace period passed,
 *     no active session, no owned Workspace, and — the one most likely to
 *     actually matter — no row in any business table (`shift`, `job_role`,
 *     `venue`, `job_offer`, `shift_assignment`, `staff_profile.created_by`,
 *     `platform_admin`) that references this user as a creator/actor. A
 *     never-activated account structurally can't have created any of that
 *     (every write path that could requires an authenticated session,
 *     which requires ACTIVE), so in practice every real candidate passes —
 *     but this is deliberately checked per-candidate, never assumed, and a
 *     single positive match retains the row (already 'invite_expired',
 *     already excluded from login) rather than deleting it. Never a blanket
 *     `DELETE FROM user WHERE status = 'invite_expired'`.
 *
 * Connects as `rab_owner` (via `DATABASE_URL_UNPOOLED`, the same
 * cross-org-maintenance convention `BootstrapAdminCommand` already
 * established this session) — this is a genuinely cross-tenant background
 * job, unlike every request-driven service in this app. Both `core.user`
 * and `core.account_invite` are ENABLE-but-not-FORCE (the latter joins the
 * pre-auth exemption allowlist in this same change — see
 * AccountInviteSchema1786670100000's own doc comment for why), so this
 * owner connection already sees every organisation's rows in both with no
 * DISABLE/ENABLE bracket needed — unlike `audit_log`, which IS FORCE'd, so
 * every row this job writes there still needs `rab.organisation_id` bound
 * first (see `writeAuditRow` below), the same pattern
 * `BootstrapAdminCommand` already established for its own owner-connection
 * audit write.
 *
 * An advisory lock (same `pg_advisory_xact_lock` idiom as
 * `BootstrapAdminCommand`) guards a single run at a time — a slow run
 * overlapping the next scheduled tick, or a second worker replica, waits
 * for the lock rather than racing.
 */
export async function runAccountInviteCleanupCycle(dataSource: DataSource): Promise<AccountInviteCleanupResult> {
  return dataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_account_invite_cleanup'))`);

    // `account_invite` is ENABLE-but-not-FORCE (AccountInviteSchema1786670100000)
    // specifically so an owner-privileged connection like this one already
    // sees every organisation's rows with no bracket needed — matching
    // `core.user`'s own long-standing pre-auth exemption.
    //
    // SELECT-then-UPDATE (no RETURNING) rather than `UPDATE ... RETURNING`,
    // deliberately — `manager.query()` returns a `[rows, rowCount]` TUPLE
    // for UPDATE/DELETE, not the bare rows array a SELECT returns (the
    // exact, previously-documented gotcha from `AdminInspectService.end()`
    // earlier this session — confirmed hit again here during this job's own
    // test run, not assumed avoided).
    const expired = await manager.query<ExpireCandidate[]>(
      `SELECT u.id, u.organisation_id
         FROM core."user" u
         JOIN core.account_invite ai ON ai.user_id = u.id
        WHERE u.status = 'invited'
          AND ai.send_number = 3
          AND ai.accepted_at IS NULL
          AND ai.revoked_at IS NULL
          AND ai.expires_at < now()`,
    );
    if (expired.length > 0) {
      await manager.query(
        `UPDATE core."user" SET status = 'invite_expired' WHERE id = ANY($1::uuid[])`,
        [expired.map((row) => row.id)],
      );
    }

    const candidates = await manager.query<CleanupCandidate[]>(
      `SELECT u.id, u.organisation_id
         FROM core."user" u
         JOIN core.account_invite ai ON ai.user_id = u.id
        WHERE u.status = 'invite_expired'
          AND ai.send_number = 3
          AND ai.cleanup_at IS NOT NULL
          AND ai.cleanup_at < now()
        LIMIT $1`,
      [BATCH_SIZE],
    );

    for (const candidate of expired) {
      await writeAuditRow(manager, candidate.organisation_id, candidate.id, 'user.invite_expired', {});
    }

    let deleted = 0;
    let retained = 0;
    for (const candidate of candidates) {
      const blockingReason = await findBlockingDependency(manager, candidate.id);
      if (blockingReason) {
        retained += 1;
        await writeAuditRow(manager, candidate.organisation_id, candidate.id, 'user.invite_cleanup_skipped', { reason: blockingReason });
        continue;
      }

      // `account_invite` rows cascade-delete via the FK — no bracket needed
      // (not FORCE'd; this owner connection already sees every org's rows).
      await manager.query(`DELETE FROM core."user" WHERE id = $1`, [candidate.id]);
      deleted += 1;
      // Written AFTER the delete, on the same connection/transaction — the
      // FK is SET NULL, not a dependency the delete itself needs, and
      // recording "this id was cleaned up" is only meaningful once it's
      // true. audit_log has no FK requiring the target row to still exist.
      await writeAuditRow(manager, candidate.organisation_id, null, 'user.invite_cleaned_up', { deletedUserId: candidate.id });
    }

    return { expired: expired.length, deleted, retained };
  });
}

// Every one of these is FORCE'd, and each has its own RLS predicate shape
// (some check workspace_id too, e.g. `venue`'s — confirmed live via
// pg_policy, not assumed) — matching each one's specific predicate with
// `set_config` would mean re-deriving per-table context this job has no
// principled way to know (which workspace should "count" for a global,
// cross-workspace safety check?). Bypassing RLS entirely for this narrow,
// read-only existence check — via the same DISABLE/ENABLE bracket already
// used for cross-org backfills in AttendanceSchema1786667000000 — is the
// correct, predicate-agnostic fix: this check must see every matching row
// in the org regardless of which workspace it belongs to, precisely
// because a private, single-workspace-scoped read is what caused it to
// silently miss real dependencies in the first place (confirmed live
// during this job's own test run: a real `venue` row referencing the
// candidate was invisible to the plain SELECT, the safety check passed
// when it should have blocked, and the DELETE then failed on
// `venue_created_by_fkey` instead of the DB simply raising a clean 500 —
// data was never actually lost, since the whole cycle runs in one
// transaction and rolled back whole).
const FORCED_DEPENDENCY_TABLES = ['shift', 'job_role', 'venue', 'shift_assignment', 'job_offer'];

/** Returns a short machine-readable reason if any business-history table references this user, or null if none do (safe to delete). */
async function findBlockingDependency(manager: import('typeorm').EntityManager, userId: string): Promise<string | null> {
  const checks: Array<[string, string]> = [
    ['shift', `SELECT 1 FROM core.shift WHERE created_by = $1 LIMIT 1`],
    ['job_role', `SELECT 1 FROM core.job_role WHERE created_by = $1 LIMIT 1`],
    ['venue', `SELECT 1 FROM core.venue WHERE created_by = $1 LIMIT 1`],
    ['shift_assignment', `SELECT 1 FROM core.shift_assignment WHERE assigned_by = $1 LIMIT 1`],
    ['job_offer', `SELECT 1 FROM core.job_offer WHERE created_by = $1 OR confirmed_by = $1 OR rejected_by = $1 LIMIT 1`],
    ['staff_profile_created_by', `SELECT 1 FROM core.staff_profile WHERE created_by = $1 LIMIT 1`],
    ['manager_workspace', `SELECT 1 FROM core.manager_workspace WHERE owner_user_id = $1 LIMIT 1`],
    ['platform_admin', `SELECT 1 FROM core.platform_admin WHERE user_id = $1 LIMIT 1`],
    ['active_session', `SELECT 1 FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`],
  ];

  for (const table of FORCED_DEPENDENCY_TABLES) {
    await manager.query(`ALTER TABLE core.${table} DISABLE ROW LEVEL SECURITY;`);
  }
  try {
    for (const [reason, sql] of checks) {
      const rows = await manager.query(sql, [userId]);
      if (rows.length > 0) return reason;
    }
    return null;
  } finally {
    for (const table of FORCED_DEPENDENCY_TABLES) {
      await manager.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
    }
  }
}

/**
 * Binds just enough tenant context, on this same owner connection/
 * transaction, for a FORCEd table's RLS policy to evaluate correctly — the
 * same `set_config` pattern `BootstrapAdminCommand` already established for
 * its own owner-connection writes. `rab.user_id`/`workspace_id`/`role` are
 * left blank (`''`) — nothing this job does needs a real acting user, and
 * every policy it touches keys only on `organisation_id`.
 */
async function bindOrgContext(manager: import('typeorm').EntityManager, organisationId: string): Promise<void> {
  await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
  await manager.query(`SELECT set_config('rab.user_id', $1, true)`, ['']);
  await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, ['']);
  await manager.query(`SELECT set_config('rab.role', $1, true)`, ['']);
}

async function writeAuditRow(
  manager: import('typeorm').EntityManager,
  organisationId: string,
  targetUserId: string | null,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // audit_log is FORCEd; this connection is the table owner with no ambient
  // tenant context — bind just enough for WITH CHECK to pass.
  await bindOrgContext(manager, organisationId);
  await manager.query(
    `INSERT INTO core.audit_log (organisation_id, actor_user_id, target_user_id, action, metadata)
     VALUES ($1, NULL, $2, $3, $4::jsonb)`,
    [organisationId, targetUserId, action, JSON.stringify(metadata)],
  );
}
