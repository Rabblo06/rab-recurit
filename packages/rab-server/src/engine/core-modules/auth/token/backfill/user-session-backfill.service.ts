import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export class UserSessionBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserSessionBackfillError';
  }
}

export interface FamilyOutcome {
  familyId: string;
  outcome: 'inserted' | 'already-present' | 'skipped-inconsistent' | 'dry-run-would-insert';
  /** SAFE reason only — never raw driver/SQL error text. */
  reason?: string;
}

export interface BackfillRunResult {
  candidatesScanned: number;
  inserted: number;
  alreadyPresent: number;
  failedClosed: number;
  families: FamilyOutcome[];
}

export interface BackfillVerifyResult {
  totalFamilies: number;
  backfilled: number;
  missing: number;
  pass: boolean;
}

interface CandidateRow {
  family_id: string;
  user_count: string;
  org_count: string;
  target_count: string;
  deadline_count: string;
  user_id: string;
  organisation_id: string;
  application_target: string;
  absolute_expires_at: string;
  created_at: string;
  last_seen_at: string;
  is_live: boolean;
  max_revoked_at: string | null;
  device_id: string | null;
  user_agent: string | null;
  ip: string | null;
}

/**
 * P1B — one-time backfill from existing `core.refresh_token` families to `core.user_session`
 * rows, for families that logged in before this phase shipped. See `1786678000000-UserSession.ts`
 * and `docs/architecture/FULL-ARCHITECTURE-UPGRADE-PLAN.md` for the full design; this is the
 * session log of HOW it's implemented.
 *
 * WHY an owner connection is required for BOTH halves (unlike `HwsBackfillService`, which only
 * needs one for physical-schema writes): the candidate SCAN needs to see every organisation's
 * refresh_token rows in one pass. `core.refresh_token` is NOT FORCE'd (the pre-auth allowlist —
 * CLAUDE.md), so the table OWNER (`rab_owner`) genuinely bypasses its RLS and sees everything;
 * `rab_app` never could, regardless of FORCE, since it is never the table owner. The WRITE side
 * (`core.user_session`, FORCE'd) binds `rab.organisation_id`/`rab.user_id` to each candidate
 * family's OWN resolved identity before its own INSERT — not a bypass, exactly the identity that
 * row's own `user_session_self` policy already requires, the same technique
 * `HwsBackfillService.writePhysical` uses for its own FORCE'd writes (HANDOFF.md §32h).
 *
 * CONSISTENCY, FAIL-CLOSED (P1B item 18-19): a family is backfilled only if every row in it
 * agrees on user_id, organisation_id, application_target AND family_expires_at — aggregated
 * directly in SQL (`COUNT(DISTINCT ...)`), never resolved by picking MIN/MAX/an arbitrary row.
 * A family that disagrees is recorded as `skipped-inconsistent` and NEVER written — no guessing.
 *
 * TERMINAL STATE (item 19): a family is "live" by the EXACT SAME definition
 * `SessionValidityService`/`core.resolve_membership_for_session` already use — a non-revoked row
 * whose `family_expires_at` hasn't passed exists. A live family backfills to an ACTIVE
 * (`revoked_at IS NULL`) UserSession; a dead one backfills to an ALREADY-REVOKED one, using the
 * family's own latest `revoked_at` if one exists (an explicit revocation happened) or its
 * `family_expires_at` itself (it simply timed out, never explicitly revoked) — never extending a
 * deadline, never reviving an expired or revoked family into an active session.
 *
 * IDEMPOTENCY (item 20): `ON CONFLICT (id) DO NOTHING` is the actual idempotency mechanism, not a
 * pre-read — a pre-read against the FORCE'd `user_session` table from an unbound connection would
 * itself be RLS-filtered to empty and therefore unreliable as an "already done" signal. Re-running
 * this service is always safe: already-present families are detected from the INSERT's own
 * affected-row count (0 = conflicted = already there) and reported as `already-present`, never
 * re-processed or duplicated.
 */
@Injectable()
export class UserSessionBackfillService {
  /** Set by the CLI command before calling `run()`/`verify()` — see `user-session-backfill.command.ts`. Never the pooled `rab_app` DataSource. */
  ownerDataSource?: DataSource;

  private requireOwner(): DataSource {
    if (!this.ownerDataSource) {
      throw new UserSessionBackfillError('An owner (rab_owner) DataSource is required for the user-session backfill — see this command\'s own doc comment.');
    }
    return this.ownerDataSource;
  }

  private async findCandidates(batchSize: number): Promise<CandidateRow[]> {
    const owner = this.requireOwner();
    return owner.query<CandidateRow[]>(
      `SELECT family_id,
              count(DISTINCT user_id) AS user_count,
              count(DISTINCT organisation_id) AS org_count,
              count(DISTINCT application_target) AS target_count,
              count(DISTINCT family_expires_at) AS deadline_count,
              -- Postgres has no built-in MIN/MAX aggregate for uuid — any element works here since
              -- COUNT(DISTINCT ...) already guarantees every row agrees when this family is consistent.
              (array_agg(user_id))[1] AS user_id,
              (array_agg(organisation_id))[1] AS organisation_id,
              min(application_target) AS application_target,
              min(family_expires_at) AS absolute_expires_at,
              min(created_at) AS created_at,
              max(created_at) AS last_seen_at,
              bool_or(revoked_at IS NULL AND family_expires_at > now()) AS is_live,
              max(revoked_at) AS max_revoked_at,
              (array_agg(device_id ORDER BY created_at ASC))[1] AS device_id,
              (array_agg(user_agent ORDER BY created_at ASC))[1] AS user_agent,
              (array_agg(ip ORDER BY created_at ASC))[1] AS ip
         FROM core.refresh_token
        GROUP BY family_id
        ORDER BY family_id
        LIMIT $1`,
      [batchSize],
    );
  }

  async run(options: { dryRun: boolean; batchSize: number }): Promise<BackfillRunResult> {
    const owner = this.requireOwner();
    const candidates = await this.findCandidates(options.batchSize);
    const families: FamilyOutcome[] = [];
    let inserted = 0;
    let alreadyPresent = 0;
    let failedClosed = 0;

    for (const row of candidates) {
      const inconsistent =
        Number(row.user_count) > 1 || Number(row.org_count) > 1 || Number(row.target_count) > 1 || Number(row.deadline_count) > 1;
      if (inconsistent) {
        failedClosed++;
        families.push({
          familyId: row.family_id,
          outcome: 'skipped-inconsistent',
          reason: 'family rows disagree on user/organisation/application target/absolute deadline',
        });
        continue;
      }
      // A genuinely malformed historical row (this codebase's own test suites have, at various
      // points, deliberately backdated `family_expires_at` into the past to simulate an expired
      // family — leaving rows where that backdated value sits BEFORE the row's own `created_at`,
      // a shape no real login ever produces). `core.user_session`'s own CHECK constraint would
      // reject this at INSERT time regardless; checked here too so it's reported the same way as
      // every other consistency failure, not a raw, batch-aborting DB error.
      if (new Date(row.created_at).getTime() > new Date(row.absolute_expires_at).getTime()) {
        failedClosed++;
        families.push({
          familyId: row.family_id,
          outcome: 'skipped-inconsistent',
          reason: 'family created_at is after its own absolute_expires_at — not a real session shape',
        });
        continue;
      }

      if (options.dryRun) {
        families.push({ familyId: row.family_id, outcome: 'dry-run-would-insert' });
        inserted++;
        continue;
      }

      const revokedAt = row.is_live ? null : (row.max_revoked_at ?? row.absolute_expires_at);
      const revokedReason = row.is_live ? null : row.max_revoked_at ? 'backfill_revoked' : 'backfill_expired';

      let result: Array<{ id: string }>;
      try {
        result = await owner.transaction(async (manager) => {
          // Bound to THIS family's own identity — satisfies user_session_self's WITH CHECK
          // without any RLS bypass or policy change. Never a cross-row/global bind.
          await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [
            row.organisation_id,
            row.user_id,
          ]);
          return manager.query(
            `INSERT INTO core.user_session
               (id, organisation_id, user_id, workspace_id, application_target, device_id, user_agent, ip_address,
                created_at, last_seen_at, absolute_expires_at, revoked_at, revoked_reason)
             VALUES ($1, $2, $3, NULL, $4, $5, $6, $7::inet, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [
              row.family_id,
              row.organisation_id,
              row.user_id,
              row.application_target,
              row.device_id,
              row.user_agent,
              row.ip,
              row.created_at,
              row.last_seen_at,
              row.absolute_expires_at,
              revokedAt,
              revokedReason,
            ],
          );
        });
      } catch {
        // One malformed/unexpected row must never abort the rest of the batch (the same
        // discipline `hws:backfill`'s own command applies per-workspace) — never the raw driver
        // message, a fixed, safe reason only.
        failedClosed++;
        families.push({ familyId: row.family_id, outcome: 'skipped-inconsistent', reason: 'database refused this row — see server logs' });
        continue;
      }

      if (result.length > 0) {
        inserted++;
        families.push({ familyId: row.family_id, outcome: 'inserted' });
      } else {
        alreadyPresent++;
        families.push({ familyId: row.family_id, outcome: 'already-present' });
      }
    }

    return { candidatesScanned: candidates.length, inserted, alreadyPresent, failedClosed, families };
  }

  /**
   * Read-only. Counts every distinct refresh_token family against how many already have a
   * matching user_session row — `pass` is true only once `missing === 0` (every live-or-dead
   * historical family has been accounted for).
   */
  async verify(): Promise<BackfillVerifyResult> {
    const owner = this.requireOwner();
    // Cross-organisation aggregate — see `count_user_session_backfill_status()`'s own doc
    // comment (in the owning migration) for why a plain LEFT JOIN from any single connection,
    // owner included, can't see this (user_session is FORCE'd).
    const [row] = await owner.query<Array<{ total_families: string; backfilled_families: string }>>(
      `SELECT * FROM core.count_user_session_backfill_status()`,
    );
    const total = Number(row?.total_families ?? 0);
    const backfilled = Number(row?.backfilled_families ?? 0);
    return { totalFamilies: total, backfilled, missing: total - backfilled, pass: total - backfilled === 0 };
  }
}
