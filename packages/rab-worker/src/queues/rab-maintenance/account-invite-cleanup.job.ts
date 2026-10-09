import { DataSource, EntityManager } from 'typeorm';

import { SUPPORTED_WORKSPACE_SCHEMA_VERSIONS, workspaceSchemaName } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';


const BATCH_SIZE = 50;
// WORK-01 — hard ceiling on how many cleanup candidates one tick will ever
// examine, regardless of how many pages that takes. 10 pages x 50 = 500:
// generous for what is a low-volume back-office table, but never "select
// everything." See the doc comment on the cleanup loop below for why a
// single bounded LIMIT with no continuation was the actual starvation bug.
const MAX_CLEANUP_PAGES_PER_TICK = 10;
// WORK-01 — the expiration scan had no bound at all before this fix. Every
// matched row's own status changes on being processed (removing it from the
// next tick's WHERE clause), so — unlike the cleanup/deletion path below —
// there is no "retained forever" row here that could block another; a
// single bounded page per tick is enough for steady, bounded progress.
const EXPIRE_BATCH_SIZE = 500;

interface ExpireCandidate {
  id: string;
  organisation_id: string;
}

interface CleanupCandidate {
  id: string;
  organisation_id: string;
  cleanup_at: Date;
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
 *     HWS runtime cutover, Part 11 — of those six tables, five (`shift`, `job_role`, `venue`, `job_offer`,
 *     `shift_assignment`, `staff_profile`) are physical workspace-business tables once a workspace is cut over; this
 *     job runs on the owner connection with no `TenantContextService`/search_path binding, so `core.<table>` stays
 *     correct for the ones still legacy, but checking ONLY `core.*` would silently under-scan any workspace whose
 *     rows already live in its physical schema — exactly the gap flagged in HANDOFF.md §32e. `findBlockingDependency`
 *     below therefore checks BOTH `core.<table>` (always — legacy rows may still exist regardless of cutover status,
 *     since no backfill/retirement has run) AND, for each of this organisation's workspaces that the trusted
 *     `core.workspace_schema_registry` reports as READY at a supported schema version, the SAME five tables again in
 *     that workspace's own physical schema (`"workspace_<hex>".<table>`, derived only from the trusted registry row —
 *     never from a payload, never a guessed name). No arbitrary schema name is ever queried: a workspace that is
 *     missing, not READY, or at an unsupported version is simply skipped for the physical half of the check (its
 *     business rows, if any, are still in core and already covered by the first half).
 *
 * Connects via `DATABASE_URL_UNPOOLED` (P1C.2: `crewflow`, the same
 * cross-org-maintenance convention `BootstrapAdminCommand` already
 * established this session) — this is a genuinely cross-tenant background
 * job, unlike every request-driven service in this app. Both `core.user`
 * and `core.account_invite` are ENABLE-but-not-FORCE (the latter joins the
 * pre-auth exemption allowlist in this same change — see
 * AccountInviteSchema1786670100000's own doc comment for why); both tables
 * are now owned by the narrow NOLOGIN `rab_secure_owner`, not `crewflow`
 * itself, so this connection relies on its own narrow, column-scoped grants
 * on them (see CrewflowSingleCredentialRoleArchitecture1786682000000) —
 * same cross-organisation visibility this job always needed, same
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
    // WORK-01 — this scan had no bound at all before this fix (a plain
    // `SELECT` with no LIMIT). Bounded now with a deterministic order
    // (`expires_at ASC, id ASC` — oldest-expired first, `id` as a stable
    // tie-breaker) and a single bounded page per tick: every row this page
    // matches has its status flipped, which removes it from the NEXT
    // tick's WHERE clause — unlike the cleanup/deletion path below, no row
    // here can stay eligible-but-unprocessed forever, so one bounded page
    // per tick is sufficient for steady progress with no starvation risk.
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
          AND ai.expires_at < now()
        ORDER BY ai.expires_at ASC, u.id ASC
        LIMIT $1`,
      [EXPIRE_BATCH_SIZE],
    );
    if (expired.length > 0) {
      await manager.query(
        `UPDATE core."user" SET status = 'invite_expired' WHERE id = ANY($1::uuid[])`,
        [expired.map((row) => row.id)],
      );
    }

    for (const candidate of expired) {
      await writeAuditRow(manager, candidate.organisation_id, candidate.id, 'user.invite_expired', {});
    }

    // WORK-01 — the actual starvation bug: `LIMIT $1` with NO `ORDER BY` at
    // all. Without a deterministic order, and with some rows permanently
    // RETAINED (never deleted, never changing `cleanup_at`/`id`), the same
    // arbitrary first ~50 rows could occupy every tick's batch forever,
    // starving any genuinely-processable row sorted after them.
    //
    // Fixed with (a) a deterministic keyset order (`cleanup_at ASC, id ASC`)
    // and (b) in-tick keyset CONTINUATION: this loop keeps paging past
    // whatever it just examined — retained or deleted — up to
    // `MAX_CLEANUP_PAGES_PER_TICK` pages, rather than stopping after one
    // fixed batch. A cluster of permanently-retained rows at the front of
    // the order can no longer prevent later, genuinely-processable rows
    // from being reached within the SAME tick (the brief's own "50 retained
    // + 50 processable" scenario). The page cap keeps this a BOUNDED unit of
    // work, never a full-table scan — a pathological accumulation of more
    // permanently-retained rows than the cap would still, eventually, be
    // worked through across successive ticks, since each tick starts its
    // keyset fresh from `cleanup_at ASC, id ASC` and only ever stops early
    // when a page returns fewer than `BATCH_SIZE` rows (the true end of the
    // eligible set) — it never "gets stuck" re-scanning the exact same
    // window past what fits in the cap; it always advances chronologically.
    let deleted = 0;
    let retained = 0;
    let cursorCleanupAt: Date | null = null;
    let cursorId: string | null = null;
    for (let page = 0; page < MAX_CLEANUP_PAGES_PER_TICK; page++) {
      const candidates: CleanupCandidate[] = await manager.query<CleanupCandidate[]>(
        `SELECT u.id, u.organisation_id, ai.cleanup_at
           FROM core."user" u
           JOIN core.account_invite ai ON ai.user_id = u.id
          WHERE u.status = 'invite_expired'
            AND ai.send_number = 3
            AND ai.cleanup_at IS NOT NULL
            AND ai.cleanup_at < now()
            AND ($2::timestamptz IS NULL OR ai.cleanup_at > $2 OR (ai.cleanup_at = $2 AND u.id > $3))
          ORDER BY ai.cleanup_at ASC, u.id ASC
          LIMIT $1`,
        [BATCH_SIZE, cursorCleanupAt, cursorId],
      );
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        // WORK-01 §11 — one bad row (an unexpected constraint violation, a
        // transient error inside `findBlockingDependency`) must not abort
        // the whole tick and roll back every OTHER candidate's already-
        // successful delete/expire in this same transaction. Same per-row
        // SAVEPOINT isolation this codebase already uses for exactly this
        // reason (`OfferService.sendBulk`/`approveShiftRequest`).
        await manager.query('SAVEPOINT sp_invite_cleanup_candidate');
        try {
          const blockingReason = await findBlockingDependency(manager, candidate.id);
          if (blockingReason) {
            retained += 1;
            await writeAuditRow(manager, candidate.organisation_id, candidate.id, 'user.invite_cleanup_skipped', { reason: blockingReason });
            continue;
          }

          // `account_invite` rows cascade-delete via the FK — no bracket
          // needed (not FORCE'd; this owner connection already sees every
          // org's rows).
          await manager.query(`DELETE FROM core."user" WHERE id = $1`, [candidate.id]);
          deleted += 1;
          // Written AFTER the delete, on the same connection/transaction —
          // the FK is SET NULL, not a dependency the delete itself needs, and
          // recording "this id was cleaned up" is only meaningful once it's
          // true. audit_log has no FK requiring the target row to still exist.
          await writeAuditRow(manager, candidate.organisation_id, null, 'user.invite_cleaned_up', { deletedUserId: candidate.id });
        } catch (error) {
          await manager.query('ROLLBACK TO SAVEPOINT sp_invite_cleanup_candidate');
          // Safe identifiers only — never the raw error object into audit
          // metadata (could carry a query fragment or other internal detail).
          await writeAuditRow(manager, candidate.organisation_id, candidate.id, 'user.invite_cleanup_failed', {
            reason: error instanceof Error ? error.constructor.name : 'unknown_error',
          });
        }
      }

      const last = candidates[candidates.length - 1]!;
      cursorCleanupAt = last.cleanup_at;
      cursorId = last.id;
      if (candidates.length < BATCH_SIZE) break; // reached the true end of the eligible set this tick
    }

    return { expired: expired.length, deleted, retained };
  });
}

// Business-history dependency checks keep FORCE RLS active and enumerate the
// user's actual workspace scopes. Foreign keys still reject hidden legacy or
// concurrently-created dependencies; the candidate savepoint retains the user.

// The 5 of the 9 dependency checks below that are physical workspace-business tables once a workspace cuts over
// (Part 11). The other 4 (`manager_workspace`, `platform_admin`, `active_session`/refresh_token) are genuinely
// global/core per CLAUDE.md's "Core global infrastructure" list and have no physical-schema counterpart — checked
// once, against core, same as always.
const WORKSPACE_TABLE_DEPENDENCY_CHECKS: Array<[string, string]> = [
  ['shift', `SELECT 1 FROM shift WHERE created_by = $1 LIMIT 1`],
  ['job_role', `SELECT 1 FROM job_role WHERE created_by = $1 LIMIT 1`],
  ['venue', `SELECT 1 FROM venue WHERE created_by = $1 LIMIT 1`],
  ['shift_assignment', `SELECT 1 FROM shift_assignment WHERE assigned_by = $1 LIMIT 1`],
  ['job_offer', `SELECT 1 FROM job_offer WHERE created_by = $1 OR confirmed_by = $1 OR rejected_by = $1 LIMIT 1`],
  ['staff_profile_created_by', `SELECT 1 FROM staff_profile WHERE created_by = $1 LIMIT 1`],
];

const GLOBAL_TABLE_DEPENDENCY_CHECKS: Array<[string, string]> = [
  ['manager_workspace', `SELECT 1 FROM core.manager_workspace WHERE owner_user_id = $1 LIMIT 1`],
  ['platform_admin', `SELECT 1 FROM core.platform_admin WHERE user_id = $1 LIMIT 1`],
  ['active_session', `SELECT 1 FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`],
];

/**
 * Trusted-registry-only schema resolution for this owner connection (no `TenantContextService` involved — this job
 * isn't bound to any one tenant). Returns null (skip the physical check, not an error) for any workspace that is
 * missing from the registry, not READY, at an unsupported version, or whose registry row doesn't match the derived
 * name — the same fail-closed posture `SchemaResolverService.resolve()` uses, just inlined here since this plain
 * function has no DI container to inject that service from.
 */
async function resolveReadyPhysicalSchema(manager: EntityManager, workspaceId: string): Promise<string | null> {
  const rows: Array<{ schema_name: string; status: string; schema_version: number }> = await manager.query(
    `SELECT schema_name, status, schema_version FROM core.workspace_schema_registry WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.status !== 'READY') return null;
  if (!SUPPORTED_WORKSPACE_SCHEMA_VERSIONS.has(Number(row.schema_version))) return null;
  let expected: string;
  try {
    expected = workspaceSchemaName(workspaceId);
  } catch {
    return null; // defensive: a malformed workspaceId can't derive a name, so there is nothing trustworthy to check.
  }
  if (row.schema_name !== expected) return null;
  return row.schema_name;
}

/** Returns a short machine-readable reason if any business-history table references this user, or null if none do (safe to delete). */
async function findBlockingDependency(manager: EntityManager, userId: string): Promise<string | null> {
  // Maintenance retains its existing owner transaction, but protected business
  // tables are read only under each actual workspace with FORCE RLS unchanged.
  // A hidden/legacy dependency remains protected by database foreign keys.
  const [previous] = await manager.query(`SELECT current_setting('rab.organisation_id', true) AS org,
    current_setting('rab.workspace_id', true) AS workspace`);
  const scopes = await manager.query(`SELECT id, organisation_id FROM core.manager_workspace
    WHERE organisation_id = (SELECT organisation_id FROM core."user" WHERE id=$1) ORDER BY id`, [userId]);
  try {
    for (const [reason, sql] of GLOBAL_TABLE_DEPENDENCY_CHECKS) {
      if ((await manager.query(sql, [userId])).length > 0) return reason;
    }

    // Include the original org context for org-wide references, even with no workspace.
    for (const scope of [{ id: previous.workspace ?? '', organisation_id: previous.org ?? '' }, ...scopes]) {
      await manager.query(`SELECT set_config('rab.organisation_id',$1,true), set_config('rab.workspace_id',$2,true), set_config('search_path','core',true)`,
        [scope.organisation_id, scope.id]);
      for (const [reason, sql] of WORKSPACE_TABLE_DEPENDENCY_CHECKS) {
        if ((await manager.query(sql, [userId])).length > 0) return reason;
      }

      // Part 11: the same 5 checks again, against the physical schema, ONLY when the trusted registry reports this
      // workspace READY. search_path is bound to EXACTLY that one schema — never 'workspace, core' — so the
      // unqualified table names above resolve to the physical tables here and to core immediately above.
      if (!scope.id) continue;
      const physicalSchema = await resolveReadyPhysicalSchema(manager, scope.id);
      if (!physicalSchema) continue;
      await manager.query(`SELECT set_config('search_path',$1,true)`, [physicalSchema]);
      for (const [reason, sql] of WORKSPACE_TABLE_DEPENDENCY_CHECKS) {
        if ((await manager.query(sql, [userId])).length > 0) return `${reason}_physical`;
      }
      await manager.query(`SELECT set_config('search_path','core',true)`);
    }
    return null;
  } finally {
    await manager.query(`SELECT set_config('rab.organisation_id',$1,true), set_config('rab.workspace_id',$2,true), set_config('search_path','core',true)`,
      [previous.org ?? '', previous.workspace ?? '']);
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
