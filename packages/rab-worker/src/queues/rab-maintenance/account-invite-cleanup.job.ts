import { DataSource, EntityManager } from 'typeorm';

import { SUPPORTED_WORKSPACE_SCHEMA_VERSIONS, workspaceSchemaName } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { bindMaintenanceSessionGucs } from '@rab/server/engine/worker-shared/maintenance-session-binder';
import { shipAuditRowAfterCommit } from '@rab/server/engine/core-modules/audit-events/audit-event-shipping';
import { isUpgradeBlocked } from '@rab/server/engine/core-modules/upgrade/workspace-upgrade-block';
import {
  bindBusinessSchema,
  businessSearchPath,
  businessTables,
  CORE_BUSINESS_SCHEMA,
  restoreBusinessSchema,
  snapshotBusinessSchema,
} from '@rab/server/engine/core-modules/tenant/business-tables';
import { clearWorkspaceUserReferences, userReferenceColumns, workspaceRestrictReference } from '@rab/server/engine/core-modules/core-references/workspace-user-references';

const WORKSPACE_UPGRADING = Symbol('workspace-upgrading');

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

export interface InviteCleanupOptions {
  /** WORKER_INVITE_AUTO_DELETE_ENABLED. Only `true` enables the Phase D definer path (expire + delete). */
  autoDeleteEnabled: boolean;
}

/** The retention flag's environment name (validated by the server's environment config — Agent C — and re-checked here). */
export const INVITE_AUTO_DELETE_ENV = 'WORKER_INVITE_AUTO_DELETE_ENABLED';

export class InviteAutoDeleteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteAutoDeleteConfigError';
  }
}

/**
 * Reads WORKER_INVITE_AUTO_DELETE_ENABLED through the same environment accessor the Worker uses for WORKER_CLAIM_MODE
 * (`resolveDispatchConfig`), fail closed:
 *  - unset / false / 'false' / '' ⇒ false (the DEFAULT — no automatic deletion of user accounts);
 *  - true / 'true' ⇒ true, outside production only;
 *  - true in production ⇒ refuses to start: enabling it needs a separate owner approval (grace period, eligibility, audit
 *    wording, retention policy, rollback/monitoring) that this release does not carry;
 *  - anything else ⇒ refuses to start (never guessed).
 */
export function resolveInviteAutoDeleteEnabled(env: { get(key: string): unknown }): boolean {
  const raw = env.get(INVITE_AUTO_DELETE_ENV);
  let enabled: boolean;
  if (raw === undefined || raw === null || raw === '' || raw === false || raw === 'false') enabled = false;
  else if (raw === true || raw === 'true') enabled = true;
  else throw new InviteAutoDeleteConfigError(`${INVITE_AUTO_DELETE_ENV} must be exactly true or false`);
  if (enabled && env.get('NODE_ENV') === 'production') {
    throw new InviteAutoDeleteConfigError(
      `${INVITE_AUTO_DELETE_ENV}=true is not allowed in production until the owner approval (grace period, eligibility, audit wording, retention policy) is recorded`,
    );
  }
  return enabled;
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
export async function runAccountInviteCleanupCycle(
  dataSource: DataSource,
  /**
   * Phase D wave 2 retention gate — `WORKER_INVITE_AUTO_DELETE_ENABLED` (default false; read by
   * `resolveInviteAutoDeleteEnabled`). Absent ⇒ OFF (fail closed): only an explicit `true` can reach the definer path.
   */
  options: InviteCleanupOptions = { autoDeleteEnabled: false },
): Promise<AccountInviteCleanupResult> {
  // D-1 (Twenty Mode M0, HIGH) — OFF means OFF. Retention gate OFF (the default; anything but the boolean `true`): return
  // before a transaction is opened, so not one statement reaches the database. The pre-fix OFF path ran the legacy
  // expire UPDATE / DELETE FROM core."user" below and relied on the login being crewflow_app (RLS, no tenant context ⇒ a
  // silent no-op, D0 F-1). On any login that owns, or is a member of the owner of, the NOT-FORCE core."user" /
  // core.account_invite — rab_secure_owner members, the superuser, Twenty Mode's schema-owning crewflow_owner — that same
  // OFF cycle expired invites and deleted accounts in every organisation. Nothing externally visible is lost by skipping
  // it: expired / revoked / consumed links are still rejected at redemption (AccountInviteService checks the live row),
  // and the 'invited' → 'invite_expired' flip is display bookkeeping only (see the doc comment above).
  if (options.autoDeleteEnabled !== true) return { expired: 0, deleted: 0, retained: 0 };

  return dataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_account_invite_cleanup'))`);

    // Phase D F-1 (D8): automatic deletion is ENABLED here (owner approval required; refused in production by
    // resolveInviteAutoDeleteEnabled). When this login can EXECUTE all three narrow definers (migration 1786721340000),
    // the cycle reaches core."user" / core.account_invite through them, which re-check every secure-table condition
    // (never signed in, no token or session ever, no owned workspace, not a platform admin) under the row lock.
    const [probe] = await manager.query<Array<{ usable: boolean | null }>>(DEFINER_PROBE_SQL);
    if (probe?.usable === true) return runDefinerCleanup(manager);

    // ON, but the definers are not executable (crewflow_app, or a database without 1786721340000): the pre-Phase-D path.
    // On crewflow_app it sees no row of either table (RLS, no tenant context) and is a no-op, exactly as before.

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
        // C2-0 (review #4): ROLLBACK TO SAVEPOINT reverts search_path but not the businessTables binding: snapshot it here.
        const bindingAtSavepoint = snapshotBusinessSchema(manager);
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
          restoreBusinessSchema(manager, bindingAtSavepoint);
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

/**
 * Phase D F-1: the three definers of migration 1786721340000 (docs/plans/PHASE-D-SQL-GATE.md §1786721340000). `to_regprocedure` returns NULL
 * for a function that does not exist (no error), and `has_function_privilege` honours role inheritance and PUBLIC, so
 * this is false on crewflow_app (no EXECUTE) and on a database without the migration.
 */
const DEFINER_FUNCTIONS = [
  'core.worker_expire_account_invites(integer)',
  'core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid)',
  'core.worker_delete_expired_invited_user(uuid)',
] as const;
// sql-injection-reviewed: function names from a module-constant list (code), never input.
const DEFINER_PROBE_SQL = `SELECT COALESCE(bool_and(f.p IS NOT NULL AND has_function_privilege(f.p, 'EXECUTE')), false) AS usable
  FROM (VALUES ${DEFINER_FUNCTIONS.map((fn) => `(to_regprocedure('${fn}'))`).join(', ')}) AS f(p)`;

interface DefinerCandidate {
  user_id: string;
  organisation_id: string;
  cleanup_at: Date;
  /** Global blocks reported by the definer (manager_workspace owner, platform_admin), or null. */
  blocking_reason: string | null;
}

/**
 * Phase D F-1 — the same two phases, rules, bounds, audits and per-candidate savepoints as the cycle above, with the
 * reads/writes of `core."user"` / `core.account_invite` (and the global blocks: owned workspace, platform admin, never
 * signed in / no token / no session) done by the definers. The workspace business-history checks stay HERE, under each of
 * the candidate's workspaces' tenant context with FORCE RLS unchanged (the workspaces come from
 * `core.worker_list_workspaces`, the Worker's existing routing catalogue). Audit rows are written by the Worker with the
 * organisation bound, as before. The delete itself is the definer's (`deleted` | `not_eligible` | `manager_workspace` |
 * `platform_admin` | `referenced`).
 */
async function runDefinerCleanup(manager: EntityManager): Promise<AccountInviteCleanupResult> {
  const expired = await manager.query<Array<{ user_id: string; organisation_id: string }>>(
    'SELECT user_id, organisation_id FROM core.worker_expire_account_invites($1::integer)',
    [EXPIRE_BATCH_SIZE],
  );
  for (const row of expired) {
    await writeAuditRow(manager, row.organisation_id, row.user_id, 'user.invite_expired', {});
  }

  let workspacesByOrg: Map<string, string[]> | null = null;
  const workspacesOf = async (organisationId: string): Promise<string[]> => {
    workspacesByOrg ??= await loadWorkspaceCatalogue(manager);
    return workspacesByOrg.get(organisationId) ?? [];
  };

  let deleted = 0;
  let retained = 0;
  let cursorCleanupAt: Date | null = null;
  let cursorId: string | null = null;
  for (let page = 0; page < MAX_CLEANUP_PAGES_PER_TICK; page++) {
    const candidates: DefinerCandidate[] = await manager.query<DefinerCandidate[]>(
      'SELECT user_id, organisation_id, cleanup_at, blocking_reason FROM core.worker_account_invite_cleanup_candidates($1::integer, $2::timestamptz, $3::uuid)',
      [BATCH_SIZE, cursorCleanupAt, cursorId],
    );
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      // C2-0 (review #4): ROLLBACK TO SAVEPOINT reverts search_path but not the businessTables binding: snapshot it here.
      const bindingAtSavepoint = snapshotBusinessSchema(manager);
      await manager.query('SAVEPOINT sp_invite_cleanup_candidate');
      try {
        // Any reason the DEFINER reports for a candidate it returns (today: manager_workspace / platform_admin; the N-4
        // re-review adds excluded users with their own skip reason - exact shape pending from Agent A) is retained and
        // audited as `user.invite_cleanup_skipped {reason}` right here; only reason-free candidates get the Worker checks.
        const blockingReason =
          candidate.blocking_reason ??
          (await findBlockingDependency(manager, candidate.user_id, {
            organisationId: candidate.organisation_id,
            workspaceIds: await workspacesOf(candidate.organisation_id),
          }));
        if (blockingReason) {
          retained += 1;
          await writeAuditRow(manager, candidate.organisation_id, candidate.user_id, 'user.invite_cleanup_skipped', { reason: blockingReason });
          continue;
        }
        const [row] = await manager.query<Array<{ outcome: string }>>('SELECT core.worker_delete_expired_invited_user($1::uuid) AS outcome', [candidate.user_id]);
        // Part D 0a (structure level 22; security review F1): the definer's foreign_key_violation guard no longer covers a
        // level-22 workspace schema (it has no foreign key to core."user"). Its former ON DELETE actions are applied here, in
        // this savepoint; anything left (or an in-schema row that still needs the profile, 23503) rolls the delete back.
        if (row?.outcome === 'deleted') await clearLevel22WorkspaceReferences(manager, candidate.user_id, candidate.organisation_id, await workspacesOf(candidate.organisation_id));
        if (row?.outcome === 'deleted') {
          deleted += 1;
          await writeAuditRow(manager, candidate.organisation_id, null, 'user.invite_cleaned_up', { deletedUserId: candidate.user_id });
        } else {
          retained += 1;
          await writeAuditRow(manager, candidate.organisation_id, candidate.user_id, 'user.invite_cleanup_skipped', { reason: row?.outcome ?? 'unknown' });
        }
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT sp_invite_cleanup_candidate');
        restoreBusinessSchema(manager, bindingAtSavepoint);
        const workspaceReason = level22RetainReason(error);
        if (workspaceReason) {
          // Part D 0a (F1): a level-22 workspace still references the invitee: retained, like the definer's 'referenced'.
          retained += 1;
          await writeAuditRow(manager, candidate.organisation_id, candidate.user_id, 'user.invite_cleanup_skipped', { reason: workspaceReason });
          continue;
        }
        await writeAuditRow(manager, candidate.organisation_id, candidate.user_id, 'user.invite_cleanup_failed', {
          reason: error instanceof Error ? error.constructor.name : 'unknown_error',
        });
      }
    }

    const last = candidates[candidates.length - 1]!;
    cursorCleanupAt = last.cleanup_at;
    cursorId = last.user_id;
    if (candidates.length < BATCH_SIZE) break;
  }

  return { expired: expired.length, deleted, retained };
}

/** organisation → workspace ids, from the routing catalogue (`core.worker_list_workspaces`, keyset pages of 100). */
async function loadWorkspaceCatalogue(manager: EntityManager): Promise<Map<string, string[]>> {
  const byOrg = new Map<string, string[]>();
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ workspace_id: string; organisation_id: string }> = await manager.query(
      'SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, 100)',
      [after],
    );
    if (!rows.length) break;
    for (const row of rows) byOrg.set(row.organisation_id, [...(byOrg.get(row.organisation_id) ?? []), row.workspace_id]);
    after = rows[rows.length - 1]!.workspace_id;
  }
  return byOrg;
}

// Business-history dependency checks keep FORCE RLS active and enumerate the
// user's actual workspace scopes. In `core` and in a workspace schema below structure level 22, foreign keys still reject
// hidden legacy or concurrently-created dependencies (the candidate savepoint retains the user). A level-22 workspace schema
// has no foreign key to core."user" (Part D 0a): there the checks run again with the worker's scan rights plus the workspace
// owner's (withLevel22Visibility), the former RESTRICT columns are probed, and after the delete the former CASCADE / SET NULL
// actions are applied and verified (clearLevel22WorkspaceReferences).

// The 5 of the 9 dependency checks below that are physical workspace-business tables once a workspace cuts over
// (Part 11). The other 4 (`manager_workspace`, `platform_admin`, `active_session`/refresh_token) are genuinely
// global/core per CLAUDE.md's "Core global infrastructure" list and have no physical-schema counterpart — checked
// once, against core, same as always.
// Part C2 (dual-schema): the statements name their tables through `businessTables(manager)`, read again after every
// binding switch in `findBlockingDependency` (this is called right after each one), so the same checks read
// `"core".<table>` in the core pass and `"workspace_<hex>".<table>` in the physical pass — the schema comes only from
// that binding (core, or the trusted registry row bound with its workspace id), never from search_path resolution.
function workspaceTableDependencyChecks(manager: EntityManager): Array<[string, string]> {
  const t = businessTables(manager);
  return [
    ['shift', `SELECT 1 FROM ${t.shift} WHERE created_by = $1 LIMIT 1`],
    ['job_role', `SELECT 1 FROM ${t.job_role} WHERE created_by = $1 LIMIT 1`],
    ['venue', `SELECT 1 FROM ${t.venue} WHERE created_by = $1 LIMIT 1`],
    ['shift_assignment', `SELECT 1 FROM ${t.shift_assignment} WHERE assigned_by = $1 LIMIT 1`],
    ['job_offer', `SELECT 1 FROM ${t.job_offer} WHERE created_by = $1 OR confirmed_by = $1 OR rejected_by = $1 LIMIT 1`],
    ['staff_profile_created_by', `SELECT 1 FROM ${t.staff_profile} WHERE created_by = $1 LIMIT 1`],
    // Owner 0g security review L2: the same two checks UserDeletionService runs before an invite's hard delete. The
    // invitee's own staff profile CASCADEs (and everything hanging off it); a note ABOUT the invitee (user_note.subject_user_id) too.
    [
      'staff_operational_history',
      `SELECT 1 FROM ${t.staff_profile} sp WHERE sp.user_id = $1 AND (
         EXISTS (SELECT 1 FROM ${t.shift_assignment} sa WHERE sa.staff_profile_id = sp.id)
         OR EXISTS (SELECT 1 FROM ${t.job_offer} jo WHERE jo.staff_profile_id = sp.id)
         OR EXISTS (SELECT 1 FROM ${t.attendance} a WHERE a.staff_profile_id = sp.id)
         OR EXISTS (SELECT 1 FROM ${t.shift_request_staff} rs WHERE rs.staff_profile_id = sp.id)
         OR EXISTS (SELECT 1 FROM ${t.venue_manager_staff} vs WHERE vs.staff_profile_id = sp.id)
         OR EXISTS (SELECT 1 FROM ${t.replacement_request} rr WHERE rr.selected_staff_profile_id = sp.id)) LIMIT 1`,
    ],
    ['user_note_subject', `SELECT 1 FROM ${t.user_note} WHERE subject_user_id = $1 LIMIT 1`],
  ];
}

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
async function resolveReadyPhysicalSchema(manager: EntityManager, workspaceId: string): Promise<string | null | typeof WORKSPACE_UPGRADING> {
  const rows: Array<{ schema_name: string; status: string; schema_version: number; migration_error: string | null }> = await manager.query(
    `SELECT schema_name, status, schema_version, migration_error FROM core.workspace_schema_registry WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.status !== 'READY') return null;
  // Part D (owner D2/D3, review Info): a workspace blocked by a failed upgrade step still HOLDS data; its dependency check is
  // not skipped (that could delete a referenced user) but the deletion is deferred until it is unblocked (fail closed).
  if (isUpgradeBlocked(row.migration_error)) return WORKSPACE_UPGRADING;
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
async function findBlockingDependency(
  manager: EntityManager,
  userId: string,
  /**
   * Phase D F-1 definer path: the global checks were done by the definer, and the candidate's scopes are given (its
   * organisation org-wide + each of its workspaces). Absent → the original behaviour, unchanged.
   */
  definerScopes?: { organisationId: string; workspaceIds: string[] },
): Promise<string | null> {
  // Maintenance retains its existing owner transaction, but protected business
  // tables are read only under each actual workspace with FORCE RLS unchanged.
  // A hidden/legacy dependency remains protected by database foreign keys.
  const [previous] = await manager.query(`SELECT current_setting('rab.organisation_id', true) AS org,
    current_setting('rab.workspace_id', true) AS workspace`);
  const scopes: Array<{ id: string; organisation_id: string }> = definerScopes
    ? [
        { id: '', organisation_id: definerScopes.organisationId },
        ...definerScopes.workspaceIds.map((id) => ({ id, organisation_id: definerScopes.organisationId })),
      ]
    : await manager.query(`SELECT id, organisation_id FROM core.manager_workspace
    WHERE organisation_id = (SELECT organisation_id FROM core."user" WHERE id=$1) ORDER BY id`, [userId]);
  // C2-0: the businessTables(manager) binding follows every search_path switch below and is put back on exit (review #4).
  const entryBinding = snapshotBusinessSchema(manager);
  try {
    if (!definerScopes) {
      for (const [reason, sql] of GLOBAL_TABLE_DEPENDENCY_CHECKS) {
        if ((await manager.query(sql, [userId])).length > 0) return reason;
      }
    }

    // Include the original org context for org-wide references, even with no workspace (definer path: the scopes above
    // already start with the candidate's organisation-wide scope).
    for (const scope of definerScopes ? scopes : [{ id: previous.workspace ?? '', organisation_id: previous.org ?? '' }, ...scopes]) {
      // C2-0: the binding is recorded (validated) before each search_path switch in this loop ('' under the test-only trap).
      bindBusinessSchema(manager, CORE_BUSINESS_SCHEMA, null);
      await manager.query(`SELECT set_config('rab.organisation_id',$1,true), set_config('rab.workspace_id',$2,true), set_config('search_path',$3,true)`,
        [scope.organisation_id, scope.id, businessSearchPath(CORE_BUSINESS_SCHEMA)]);
      for (const [reason, sql] of workspaceTableDependencyChecks(manager)) {
        if ((await manager.query(sql, [userId])).length > 0) return reason;
      }

      // Part 11: the same 5 checks again, against the physical schema, ONLY when the trusted registry reports this
      // workspace READY. search_path and the businessTables binding are switched to EXACTLY that one schema — never
      // 'workspace, core' — so the same checks name the physical tables here and the core tables immediately above.
      if (!scope.id) continue;
      const physicalSchema = await resolveReadyPhysicalSchema(manager, scope.id);
      if (physicalSchema === WORKSPACE_UPGRADING) return 'workspace_upgrading';
      if (!physicalSchema) {
        // Security re-review N1: a workspace schema that exists but does not resolve (not READY, unsupported version, name
        // mismatch) cannot be checked: retained, never skipped (UserDeletionService.checkableWorkspaceSchema, same rule).
        await assertNoUnresolvedSchema(manager, scope.id);
        continue;
      }
      bindBusinessSchema(manager, physicalSchema, scope.id);
      await manager.query(`SELECT set_config('search_path',$1,true)`, [businessSearchPath(physicalSchema)]);
      for (const [reason, sql] of workspaceTableDependencyChecks(manager)) {
        if ((await manager.query(sql, [userId])).length > 0) return `${reason}_physical`;
      }
      // Part D 0a (F1): no foreign key guards a level-22 schema, so the same checks run again where they can see every row
      // (worker scan + workspace owner), plus the former no-ON-DELETE user columns. Unverifiable → retained (fail closed).
      if (await isLevel22(manager, scope.id)) {
        const hit = await withLevel22Visibility(manager, scope.id, async () => {
          for (const [reason, sql] of workspaceTableDependencyChecks(manager)) {
            if ((await manager.query(sql, [userId])).length > 0) return `${reason}_physical`;
          }
          const ref = await workspaceRestrictReference(manager, userId);
          return ref ? `workspace_reference_physical:${ref}` : null;
        });
        if (hit) return hit;
      }
      bindBusinessSchema(manager, CORE_BUSINESS_SCHEMA, null);
      await manager.query(`SELECT set_config('search_path',$1,true)`, [businessSearchPath(CORE_BUSINESS_SCHEMA)]);
    }
    return null;
  } finally {
    // The entry binding comes back (review #4: not 'core'), and search_path with it: the entry schema when one was bound,
    // else 'core' exactly as before. The binding is restored first: if this statement fails (an aborted transaction), the
    // caller's ROLLBACK TO SAVEPOINT reverts search_path and restores its own snapshot.
    restoreBusinessSchema(manager, entryBinding);
    await manager.query(`SELECT set_config('rab.organisation_id',$1,true), set_config('rab.workspace_id',$2,true), set_config('search_path',$3,true)`,
      [previous.org ?? '', previous.workspace ?? '', businessSearchPath(entryBinding.schema ?? CORE_BUSINESS_SCHEMA)]);
  }
}

/** Part D 0a: the workspace's registry structure level is 22 or above (no foreign key to core."user" in its schema). */
async function isLevel22(manager: EntityManager, workspaceId: string): Promise<boolean> {
  const [row] = await manager.query<Array<{ module_version: number | null }>>(`SELECT module_version FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
  return Number(row?.module_version ?? 0) >= 22;
}

/**
 * Security re-review N1: a catalogued workspace whose `workspace_<hex>` namespace EXISTS but did not resolve through the trusted
 * registry (not READY, unsupported schema_version, name mismatch) may hold rows nobody checked: Level22Retain
 * ('workspace_unverifiable'), the candidate is retained. No namespace at all: nothing to check (the workspace has no schema).
 */
async function assertNoUnresolvedSchema(manager: EntityManager, workspaceId: string): Promise<void> {
  let name: string;
  try {
    name = workspaceSchemaName(workspaceId);
  } catch {
    throw new Level22Retain('workspace_unverifiable');
  }
  const [row] = await manager.query<Array<{ present: boolean }>>(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present`, [name]);
  if (row?.present) throw new Level22Retain('workspace_unverifiable');
}

class Level22Retain extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'Level22Retain';
  }
}

/** Why a failed candidate is retained because of a level-22 workspace (null: a genuine failure, audited as failed). */
function level22RetainReason(error: unknown): string | null {
  if (error instanceof Level22Retain) return error.reason;
  const driver = (error as { driverError?: { code?: string; constraint?: string } } | null)?.driverError;
  // 23503, or 23001 (restrict_violation) on PostgreSQL 18 for a RESTRICT key: the same "still referenced".
  return driver?.code === '23503' || driver?.code === '23001' ? `workspace_referenced:${driver.constraint ?? 'unknown'}` : null;
}

/**
 * Part D 0a (security review F1): runs `run` in the bound level-22 workspace schema with the worker's scan rights
 * (`rab.actor_type` = worker: staff_profile, payroll_record, payroll_run, shift_staff_review) plus the workspace owner's
 * (`rab.user_id` = manager_workspace.owner_user_id: payslip, payslip_document, venue_manager_staff, staff_profile DELETE /
 * UPDATE). The same binding as the orphan check (owner decision 0a-T2, SECURITY TRADE-OFF). No owner → Level22Retain (fail
 * closed). Restored on success; on a throw the candidate savepoint rolls the transaction-local settings back.
 *
 * The marker is bound only through the trusted binder (tenant-context.service.ts bindMaintenanceSessionGucs: the one binding
 * statement, never a raw set_config of rab.actor_type — worker-actor-type-trusted-only.spec.ts). That statement writes all
 * nine identity GUCs, so the organisation, workspace and role in force are re-bound unchanged, and on the way out everything
 * is bound back with the previous user and no marker. Fail closed if the marker or an optional scope GUC (team_shift_id,
 * team_staff_id, admin_scope, upgrade_scope) is already set: this job never sets them, and the binder resets them to ''.
 */
async function withLevel22Visibility<T>(manager: EntityManager, workspaceId: string, run: () => Promise<T>): Promise<T> {
  const [owner] = await manager.query<Array<{ owner_user_id: string | null }>>(`SELECT owner_user_id FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
  if (!owner?.owner_user_id) throw new Level22Retain('workspace_unverifiable');
  const [previous] = await manager.query<Array<Record<'org' | 'workspace' | 'uid' | 'role' | 'actor' | 'team_shift' | 'team_staff' | 'admin_scope' | 'upgrade_scope', string | null>>>(
    `SELECT current_setting('rab.organisation_id', true) AS org, current_setting('rab.workspace_id', true) AS workspace,
            current_setting('rab.user_id', true) AS uid, current_setting('rab.role', true) AS role, current_setting('rab.actor_type', true) AS actor,
            current_setting('rab.team_shift_id', true) AS team_shift, current_setting('rab.team_staff_id', true) AS team_staff,
            current_setting('rab.admin_scope', true) AS admin_scope, current_setting('rab.upgrade_scope', true) AS upgrade_scope`,
  );
  if (previous?.actor || previous?.team_shift || previous?.team_staff || previous?.admin_scope || previous?.upgrade_scope) {
    throw new Error('level-22 visibility: the transaction already carries the worker marker or an optional scope; refusing to re-bind it');
  }
  const query = (sql: string, params: unknown[]) => manager.query(sql, params);
  const inForce = { organisationId: previous?.org || null, workspaceId: previous?.workspace || null, userId: previous?.uid ?? '', role: previous?.role ?? '' };
  await bindMaintenanceSessionGucs(query, { ...inForce, userId: owner.owner_user_id, actorType: 'worker' });
  const result = await run();
  await bindMaintenanceSessionGucs(query, inForce);
  return result;
}

/**
 * Part D 0a (security review F1), after `core.worker_delete_expired_invited_user` deleted the invitee: in every READY level-22
 * schema of its organisation, the former ON DELETE actions (CASCADE the invitee's own staff profile and the notes about it,
 * SET NULL the attribution columns), then a check that no reference is left. A row that still needs the profile raises 23503;
 * a reference that could not be removed raises Level22Retain. Either rolls the candidate savepoint back (retained).
 */
async function clearLevel22WorkspaceReferences(manager: EntityManager, userId: string, organisationId: string, workspaceIds: readonly string[]): Promise<void> {
  const entryBinding = snapshotBusinessSchema(manager);
  const [previous] = await manager.query<Array<{ org: string | null; workspace: string | null }>>(
    `SELECT current_setting('rab.organisation_id', true) AS org, current_setting('rab.workspace_id', true) AS workspace`,
  );
  for (const workspaceId of workspaceIds) {
    // The registry rows are read under the workspace's own tenant binding (the production login sees nothing otherwise and
    // would resolve no schema at all: N1 below would then retain every candidate).
    bindBusinessSchema(manager, CORE_BUSINESS_SCHEMA, null);
    await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('search_path', $3, true)`, [
      organisationId,
      workspaceId,
      businessSearchPath(CORE_BUSINESS_SCHEMA),
    ]);
    const physicalSchema = await resolveReadyPhysicalSchema(manager, workspaceId);
    if (physicalSchema === WORKSPACE_UPGRADING) throw new Level22Retain('workspace_upgrading');
    if (!physicalSchema) {
      await assertNoUnresolvedSchema(manager, workspaceId); // N1: present but unresolvable → retained
      continue;
    }
    if (!(await isLevel22(manager, workspaceId))) continue;
    bindBusinessSchema(manager, physicalSchema, workspaceId);
    await manager.query(`SELECT set_config('search_path', $1, true)`, [businessSearchPath(physicalSchema)]);
    await withLevel22Visibility(manager, workspaceId, async () => {
      await clearWorkspaceUserReferences(manager, userId);
      const t = businessTables(manager);
      for (const c of userReferenceColumns()) {
        // sql-injection-reviewed: the table comes from businessTables (validated schema, WORKSPACE_TABLES name); the column is a constant of the frozen list.
        const left = await manager.query(`SELECT 1 FROM ${t[c.table]} WHERE ${c.column} = $1 LIMIT 1`, [userId]);
        if (left.length > 0) throw new Level22Retain(`workspace_reference_physical:${c.table}.${c.column}`);
      }
    });
  }
  restoreBusinessSchema(manager, entryBinding);
  await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('search_path', $3, true)`, [
    previous?.org ?? '',
    previous?.workspace ?? '',
    businessSearchPath(entryBinding.schema ?? CORE_BUSINESS_SCHEMA),
  ]);
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
  const inserted = await manager.query<Array<{ id?: string }> | undefined>(
    `INSERT INTO core.audit_log (organisation_id, actor_user_id, target_user_id, action, metadata)
     VALUES ($1, NULL, $2, $3, $4::jsonb)
     RETURNING id`,
    [organisationId, targetUserId, action, JSON.stringify(metadata)],
  );
  // X1.1: the same off-host path as AuditService.record — queued after this transaction commits (`user.invite_cleaned_up`
  // is an account deletion), never awaited. A row undone by the per-candidate ROLLBACK TO SAVEPOINT is not found by the
  // Worker's re-read, so nothing is shipped for it.
  const auditLogId = Array.isArray(inserted) ? inserted[0]?.id : undefined;
  if (typeof auditLogId === 'string') shipAuditRowAfterCommit(manager, { organisationId, auditLogId, action });
}
