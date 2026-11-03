import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { storageScopes } from '../../../engine/worker-shared/maintenance-catalogue';
import { AiTurnRunnerService } from './ai-turn-runner.service';

/**
 * AI-eligible users are listed per workspace in keyset pages of this size (`user_id > cursor`), until a short page. The
 * schema allows several CEO profiles in one workspace, so there is NO per-workspace user cap: every eligible user is
 * examined on every cycle that reaches the workspace (CodeRabbit on #46). Work per cycle stays bounded by the
 * finalisation cap below.
 */
export const AI_STALE_SWEEP_USER_PAGE_SIZE = 20;
/** At most this many stale turns are finalised per user per cycle; the rest wait for the next cycle. */
export const AI_STALE_SWEEP_TURNS_PER_USER = 20;
/** Hard cap of finalisations per cycle (bounded work per tick). */
export const AI_STALE_SWEEP_MAX_FINALISED_PER_CYCLE = 200;

export interface AiStaleTurnSweepResult {
  ran: boolean;
  workspaces: number;
  users: number;
  candidates: number;
  finalised: number;
  /** Workspaces skipped because their scope could not be bound (not routable yet) or the read failed — retried next cycle. */
  skipped: number;
}

/**
 * Phase D-Q2 (AI_STALE_TURN_SWEEP, default false): the bounded Worker scan that ends AI turns stuck in `queued` because
 * their BullMQ job was lost (Redis data loss, a dropped promotion/deferral job). Without it such a turn stays `queued`
 * until the user cancels it (audit inventory Q4 / plan §13 #10 — verified: no other automatic recovery exists; the
 * runner only ever looks at a turn when a job for it is delivered).
 *
 * Owner rule (2026-11-02, decision 7 still open): fail-and-user-retry ONLY — a stale queued turn is FINALISED as failed
 * (`AI_WORKER_INTERRUPTED`, the existing interrupted/failed path), never re-run, requeued or replayed.
 *
 * Discovery (no new definer, no migration, no cross-tenant SQL): `core.ai_message` is visible only with organisation,
 * workspace AND user bound (owner-scoped RLS), so an organisation-only context sees nothing. The scan therefore walks the
 * existing catalogue (`storageScopes`: `core.worker_list_organisations` + `core.worker_list_workspaces`, maintenance-
 * catalogue.ts) and, per workspace, inside that workspace's own tenant context, lists the users who can hold AI turns
 * there (the workspace owner, and CEO / Initial Manager profiles placed in it — the only AI-eligible actors,
 * `core.ai_actor_eligible()`), then reads each user's stale queued turns in THAT user's own (organisation, workspace,
 * user) context — exactly the binding the turn runner uses for a delivered job. Every write is the runner's own
 * compare-and-set (`AiTurnRunnerService.finaliseStaleQueued`).
 *
 * Bounded: users are read in keyset pages, turns per user and finalisations per cycle are capped; a failing workspace is
 * skipped and retried next cycle. No cursor survives between cycles, and none is needed: only FINALISED turns count
 * towards the cycle cap, and a finalised turn is no longer `queued`, so the next cycle, restarting from the first page,
 * no longer sees it and reaches the users after it. Two replicas: the compare-and-set makes exactly one of them finalise
 * a turn.
 */
@Injectable()
export class AiStaleTurnSweepService {
  private readonly logger = new Logger('AiStaleTurnSweep');

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly runner: AiTurnRunnerService,
    private readonly env: EnvironmentService,
  ) {}

  /** Exactly `true` turns the sweep on; anything else is off (fail closed). */
  get enabled(): boolean {
    return this.env.get('AI_STALE_TURN_SWEEP') === true;
  }

  get staleAfterMs(): number {
    return this.env.get('AI_STALE_TURN_THRESHOLD_MINUTES') * 60_000;
  }

  async runCycle(
    catalogue: DataSource,
    opts: { maxFinalised?: number } = {},
  ): Promise<AiStaleTurnSweepResult> {
    const result: AiStaleTurnSweepResult = {
      ran: false,
      workspaces: 0,
      users: 0,
      candidates: 0,
      finalised: 0,
      skipped: 0,
    };
    if (!this.enabled) return result; // defence in depth: the scan is not even registered when off
    const staleAfterMs = this.staleAfterMs;
    if (!this.runner.isSafeStaleQueuedThreshold(staleAfterMs)) {
      this.logger.warn(
        'AI stale-turn sweep refused: the threshold does not exceed the longest legitimate queued wait',
      );
      return result;
    }
    result.ran = true;
    const cap = Math.max(
      1,
      Math.min(
        opts.maxFinalised ?? AI_STALE_SWEEP_MAX_FINALISED_PER_CYCLE,
        AI_STALE_SWEEP_MAX_FINALISED_PER_CYCLE,
      ),
    );
    for await (const scope of storageScopes(catalogue)) {
      if (!scope.workspaceId) continue; // organisation-only scope: ai_message is invisible there by design
      if (result.finalised >= cap) break;
      result.workspaces++;
      const workspaceId = scope.workspaceId;
      let users: string[];
      try {
        users = await this.listEligibleUsers(scope.organisationId, workspaceId);
      } catch (error) {
        result.skipped++;
        this.logger.warn(
          `AI stale-turn sweep: workspace skipped (${(error as Error)?.name ?? 'Error'}); retried next cycle`,
        );
        continue;
      }
      for (const userId of users) {
        if (result.finalised >= cap) break;
        result.users++;
        let turns: Array<{ id: string; conversation_id: string }>;
        try {
          turns = await this.tenantContext.runInTenantContext(
            this.ctx(scope.organisationId, workspaceId, userId),
            (m) =>
              m.query<Array<{ id: string; conversation_id: string }>>(
                `SELECT id, conversation_id FROM core.ai_message
                WHERE role = 'assistant' AND status = 'queued' AND created_at < now() - ($1 || ' milliseconds')::interval
                ORDER BY created_at, id
                LIMIT $2`,
                [String(staleAfterMs), AI_STALE_SWEEP_TURNS_PER_USER],
              ),
          );
        } catch (error) {
          result.skipped++;
          this.logger.warn(
            `AI stale-turn sweep: user scope skipped (${(error as Error)?.name ?? 'Error'}); retried next cycle`,
          );
          continue;
        }
        for (const t of turns) {
          if (result.finalised >= cap) break;
          result.candidates++;
          try {
            const done = await this.runner.finaliseStaleQueued(
              {
                turnId: t.id,
                conversationId: t.conversation_id,
                organisationId: scope.organisationId,
                workspaceId,
                userId,
              },
              staleAfterMs,
            );
            if (done) result.finalised++;
          } catch (error) {
            this.logger.warn(
              `AI stale-turn sweep: turn ${t.id} not finalised (${(error as Error)?.name ?? 'Error'}); retried next cycle`,
            );
          }
        }
      }
    }
    return result;
  }

  /**
   * Every user who can hold AI turns in the workspace (its owner, and CEO / Initial Manager profiles placed in it), read
   * in that workspace's own tenant context in keyset pages ordered by user_id, until a page comes back short.
   */
  private async listEligibleUsers(organisationId: string, workspaceId: string): Promise<string[]> {
    const users: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: string[] = await this.tenantContext.runInTenantContext(
        this.ctx(organisationId, workspaceId, ''),
        async (m) => {
          const rows = await m.query<Array<{ user_id: string }>>(
            `SELECT user_id FROM (
              SELECT w.owner_user_id AS user_id FROM core.manager_workspace w WHERE w.id = $1
              UNION
              SELECT p.user_id FROM core.manager_profile p
               WHERE p.organisation_id = $2 AND p.workspace_id = $1 AND (p.type = 'ceo' OR p.is_initial_manager)
            ) candidates
           WHERE $4::uuid IS NULL OR user_id > $4::uuid
           ORDER BY user_id
           LIMIT $3`,
            [workspaceId, organisationId, AI_STALE_SWEEP_USER_PAGE_SIZE, after],
          );
          return rows.map((r) => r.user_id);
        },
      );
      users.push(...page);
      if (page.length < AI_STALE_SWEEP_USER_PAGE_SIZE) return users;
      after = page[page.length - 1]!;
    }
  }

  private ctx(
    organisationId: string,
    workspaceId: string,
    userId: string,
  ): AuthContext {
    return { organisationId, workspaceId, userId, role: '' };
  }
}
