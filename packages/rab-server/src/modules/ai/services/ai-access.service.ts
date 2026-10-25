import { AiUnavailableReason, AiUnavailableReasonType, PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { DISPOSABLE_TEST_DATABASE_SETTING } from '../../../database/typeorm/core/test-database-guard';
import { SessionValidityService } from '../../../engine/core-modules/auth/services/session-validity.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiAccessRevokedError, AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';

/** AiAccessRevokedError reasons the Worker maps to the fixed AI_SERVICE_UNAVAILABLE message (not "access revoked"). */
export const PLATFORM_NOT_READY = 'platform_not_ready';
export const REAL_PROVIDER_NOT_PERMITTED = 'real_provider_not_permitted';

/** Owner condition 5, per turn: a real provider only for a `synthetic_data` organisation on a non-test database. */
export function realProviderPermitted(realProvider: boolean, facts: Pick<AiFacts, 'synthetic' | 'testMarked'>): boolean {
  return !realProvider || (facts.synthetic && !facts.testMarked);
}

export type AiAvailability = { available: true } | { available: false; reason: AiUnavailableReasonType };

/** Flags an AI tool may require (each tool declares one). */
export const AI_TOOL_PERMISSION_FLAGS: readonly PermissionFlagType[] = [PermissionFlag.SCHEDULE_VIEW, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.PAYROLL_VIEW, PermissionFlag.VENUE_VIEW];

/**
 * The caller's AI authority as the Worker REBUILT it from PostgreSQL — never from job data, a JWT or a cache. `permissions`
 * holds only the tool flags the user holds right now; `timezone` is the organisation's (date ranges are local days).
 */
export interface AiActor {
  organisationId: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  timezone: string;
  permissions: ReadonlySet<PermissionFlagType>;
  /**
   * The configured model may run for THIS turn. Always true for the in-process mock; for a real provider only when the
   * organisation is marked `synthetic_data` and the database is not a disposable test database (owner condition 5 —
   * the platform-level conditions are part of readiness).
   */
  realProviderPermitted: boolean;
}

interface AiFacts {
  eligible: boolean;
  organisationEnabled: boolean;
  /** `organisation_ai_setting.synthetic_data` — set only by the dev seed's definer function. */
  synthetic: boolean;
  /** The database carries the disposable-test marker (test-database-guard.ts). */
  testMarked: boolean;
}

/** The tenant context every AI query binds (never platform/owner context). */
export function aiTenantContext(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>): AuthContext {
  return { organisationId: actor.organisationId, workspaceId: actor.workspaceId, userId: actor.userId, role: '', sessionId: actor.sessionId };
}

/**
 * Two-level enablement + AI_USE + eligibility, in ONE place, re-run at every point the owner listed (docs/ai/PHASE1_PLAN.md
 * §4): opening/listing/reading (request guard + service), submit, before enqueue, Worker start (`rebuildForWorker`),
 * before each tool is offered (the actor's permission set), immediately before each tool runs (`assertStillAllowed`) and
 * while streaming (SSE re-validation).
 *
 * AI is available to a request only when ALL hold:
 *   1. the platform kill switch AI_ENABLED is on;
 *   2. the request is not an Admin Inspect session (an inspecting administrator never reads another user's transcripts);
 *   3. the user holds `ai.use` (resolved server-side per request — the security snapshot, never the JWT);
 *   4. the user is the organisation's CEO or its CURRENT Initial Manager (`core.ai_actor_eligible()`, the same predicate
 *      the RLS WITH CHECK enforces on every AI insert);
 *   5. the session has a workspace (AI is single-workspace: conversations and every tool read are bound to it);
 *   6. the organisation's AI switch (`core.organisation_ai_setting`, default OFF) is on;
 *   7. (Part A) the AI configuration is READY (ai-readiness.ts: catalogue, approval, key, dev flag, development
 *      database) and, when the model is a real provider, the organisation is marked `synthetic_data` on a database that
 *      is not a disposable test database. Otherwise AI is unavailable to that organisation (uniform 404; the Worker
 *      refuses the turn before any model call).
 * Account status, organisation suspension, maintenance and the manager_web application target are enforced for every
 * request by JwtAuthGuard / @ManagerApplication before this runs; the Worker re-checks them itself.
 */
@Injectable()
export class AiAccessService {
  constructor(
    private readonly config: AiConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly sessionValidity: SessionValidityService,
    private readonly dataSource: DataSource,
  ) {}

  /** Request-time evaluation (the `GET /ai/availability` answer and the basis of every route's uniform 404). */
  async evaluate(ctx: AuthContext): Promise<AiAvailability> {
    const readiness = this.config.readiness();
    if (!readiness.ready) return { available: false, reason: AiUnavailableReason.PLATFORM_DISABLED };
    if (ctx.inspectedBy) return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    if (!ctx.organisationId || !ctx.security?.effectivePermissions.has(PermissionFlag.AI_USE)) {
      return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    }
    if (!ctx.workspaceId) return { available: false, reason: AiUnavailableReason.NO_WORKSPACE };
    const facts = await this.tenantContext.runInTenantContext({ ...ctx, role: '' }, (m) => this.readFacts(m, ctx.organisationId!));
    if (!facts.eligible) return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    if (!facts.organisationEnabled || !realProviderPermitted(readiness.realProvider, facts)) return { available: false, reason: AiUnavailableReason.ORGANISATION_DISABLED };
    return { available: true };
  }

  /** Layer 2 for every AI service entry point: anything short of "available" is the uniform 404. */
  async assertAvailable(ctx: AuthContext): Promise<void> {
    if (!(await this.evaluate(ctx)).available) throw new AiNotAvailableException();
  }

  /**
   * Same checks inside an already-open, tenant-bound transaction (submit path: the check and the inserts share one
   * snapshot). `ai.use` is re-read from the database here, not from the request snapshot.
   */
  async assertAvailableTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    const readiness = this.config.readiness();
    if (!readiness.ready || ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiNotAvailableException();
    const facts = await this.readFacts(m, ctx.organisationId);
    if (!facts.eligible || !facts.organisationEnabled || !realProviderPermitted(readiness.realProvider, facts)) throw new AiNotAvailableException();
  }

  /**
   * Worker start: rebuild the actor from PostgreSQL only. The job's ids are LOOKUP INPUTS: the session must still be live
   * (read-only check — a background turn never extends an idle session), resolve to the SAME user, organisation and
   * workspace, the account must be active, the organisation not suspended and not in maintenance, and every AI gate must
   * still hold. Anything else throws AiAccessRevokedError (the turn stops; nothing is sent to the model).
   */
  async rebuildForWorker(input: { organisationId: string; workspaceId: string; userId: string; sessionId: string }): Promise<AiActor> {
    const readiness = this.assertPlatformReady();
    return this.dataSource.transaction('REPEATABLE READ', async (m) => {
      const [membership] = await m.query<Array<{ user_id: string; organisation_id: string; workspace_id: string | null }>>(
        'SELECT user_id, organisation_id, workspace_id FROM core.resolve_membership_for_session($1)',
        [input.sessionId],
      );
      if (!membership || membership.user_id !== input.userId || membership.organisation_id !== input.organisationId) throw new AiAccessRevokedError('session');
      if (membership.workspace_id !== input.workspaceId) throw new AiAccessRevokedError('workspace');
      const ctx = aiTenantContext(input);
      await this.tenantContext.bindCoreIdentityGucs(m, ctx);
      try {
        await this.sessionValidity.assertActiveReadOnly(m, { sid: input.sessionId, userId: input.userId, organisationId: input.organisationId });
      } catch {
        throw new AiAccessRevokedError('session');
      }
      const timezone = await this.assertAccountAndOrganisation(m, input.userId, input.organisationId);
      if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiAccessRevokedError('permission');
      const facts = await this.readFacts(m, input.organisationId);
      if (!facts.eligible) throw new AiAccessRevokedError('eligibility');
      if (!facts.organisationEnabled) throw new AiAccessRevokedError('organisation_disabled');
      if (!realProviderPermitted(readiness.realProvider, facts)) throw new AiAccessRevokedError(REAL_PROVIDER_NOT_PERMITTED);
      const permissions = new Set<PermissionFlagType>();
      for (const flag of AI_TOOL_PERMISSION_FLAGS) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) permissions.add(flag);
      return { ...input, timezone, permissions, realProviderPermitted: true };
    });
  }

  /**
   * Immediately before a tool runs (and periodically while a turn or stream is open): the session, account,
   * organisation, every AI gate and — when given — the tool's own permission, re-read in a fresh short transaction.
   */
  async assertStillAllowed(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>, flag?: PermissionFlagType): Promise<void> {
    const readiness = this.assertPlatformReady();
    const ctx = aiTenantContext(actor);
    await this.tenantContext.runInTenantContext(ctx, async (m) => {
      try {
        await this.sessionValidity.assertActiveReadOnly(m, { sid: actor.sessionId, userId: actor.userId, organisationId: actor.organisationId });
      } catch {
        throw new AiAccessRevokedError('session');
      }
      await this.assertAccountAndOrganisation(m, actor.userId, actor.organisationId);
      if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiAccessRevokedError('permission');
      if (flag && !(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new AiAccessRevokedError('tool_permission');
      const facts = await this.readFacts(m, actor.organisationId);
      if (!facts.eligible) throw new AiAccessRevokedError('eligibility');
      if (!facts.organisationEnabled) throw new AiAccessRevokedError('organisation_disabled');
      if (!realProviderPermitted(readiness.realProvider, facts)) throw new AiAccessRevokedError(REAL_PROVIDER_NOT_PERMITTED);
    });
  }

  /**
   * Owner-approved Part A exception, control (a): run IMMEDIATELY before every real-provider request (each step). A fresh,
   * READ ONLY, tenant-scoped transaction asks `core.ai_dev_synthetic_check()` whether the bound organisation is still
   * marked `synthetic_data` and every one of its users has an address ending exactly `@example.test` (and the database
   * is not a disposable test database). Never cached. Returns 'ok' or a fixed reason code (never data); any error is a
   * refusal ('check_failed').
   */
  async syntheticCheckForRealRequest(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>): Promise<string> {
    try {
      return await this.tenantContext.runInTenantContext(aiTenantContext(actor), async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        const [row] = await m.query<Array<{ result: string | null }>>(`SELECT core.ai_dev_synthetic_check() AS result`);
        return row?.result ?? 'check_failed';
      });
    } catch {
      return 'check_failed';
    }
  }

  /** Kill switch + configuration readiness (the platform half of every Worker re-check). */
  private assertPlatformReady() {
    if (!this.config.enabled) throw new AiAccessRevokedError('platform_disabled');
    const readiness = this.config.readiness();
    if (!readiness.ready) throw new AiAccessRevokedError(PLATFORM_NOT_READY);
    return readiness;
  }

  /** Eligibility (CEO / current Initial Manager) and the organisation switch, under the bound tenant context. */
  private async readFacts(m: EntityManager, organisationId: string): Promise<AiFacts> {
    const [row] = await m.query<Array<{ eligible: boolean; enabled: boolean | null; synthetic: boolean | null; test_marked: boolean | null }>>(
      `SELECT core.ai_actor_eligible() AS eligible,
              (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled,
              (SELECT s.synthetic_data FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS synthetic,
              -- The DATABASE-level marker from the catalog (test-database-guard.ts): a session or connection-string SET
              -- cannot hide it. Same predicate as core.ai_dev_mark_organisation_synthetic.
              EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
                       WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0 AND cfg = $2) AS test_marked`,
      [organisationId, `${DISPOSABLE_TEST_DATABASE_SETTING}=true`],
    );
    return {
      eligible: row?.eligible === true,
      organisationEnabled: row?.enabled === true,
      // Anything but an explicit true (no row, NULL) is "not synthetic"; a marker read that is not an explicit false is "test".
      synthetic: row?.synthetic === true,
      testMarked: row?.test_marked !== false,
    };
  }

  /** Active account, organisation not suspended, platform not in maintenance. Returns the organisation's timezone. */
  private async assertAccountAndOrganisation(m: EntityManager, userId: string, organisationId: string): Promise<string> {
    const [row] = await m.query<Array<{ status: string | null; suspended: boolean | null; maintenance: boolean | null; timezone: string | null }>>(
      `SELECT (SELECT u.status FROM core."user" u WHERE u.id = $1) AS status,
              (SELECT o.suspended_at IS NOT NULL FROM core.organisation o WHERE o.id = $2) AS suspended,
              (SELECT o.timezone FROM core.organisation o WHERE o.id = $2) AS timezone,
              (SELECT pc.maintenance_mode_enabled FROM core.platform_config pc WHERE pc.organisation_id = $2) AS maintenance`,
      [userId, organisationId],
    );
    if (!row || row.status !== UserStatus.ACTIVE) throw new AiAccessRevokedError('account');
    if (row.suspended !== false) throw new AiAccessRevokedError('organisation_suspended');
    if (row.maintenance === true) throw new AiAccessRevokedError('maintenance');
    return row.timezone || 'Europe/London';
  }
}
