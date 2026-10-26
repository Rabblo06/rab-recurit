import { AiModelLevel, AiSetupNeededV2, AiUnavailableReason, AiUnavailableReasonType, PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { DISPOSABLE_TEST_DATABASE_SETTING } from '../../../database/typeorm/core/test-database-guard';
import { AiLevelPinsFacts, AiLevelResolutionFacts, AiModelPolicyFacts, levelPinsFromRows, policyFromRow } from '../../../engine/core-modules/ai/ai-levels';
import { AiModelPins, AiResolutionSource } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { SessionValidityService } from '../../../engine/core-modules/auth/services/session-validity.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiAccessRevokedError, AiDemoDataOnlyException, AiNotAvailableException, AiNotConfiguredException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';

/** AiAccessRevokedError reasons the Worker maps to the fixed AI_SERVICE_UNAVAILABLE message (not "access revoked"). */
export const PLATFORM_NOT_READY = 'platform_not_ready';
export const REAL_PROVIDER_NOT_PERMITTED = 'real_provider_not_permitted';

/** EX-1 / rule 3.7, per turn: a real provider only for a `synthetic_data` organisation on a non-test database. */
export function realProviderPermitted(realProvider: boolean, facts: Pick<AiFacts, 'synthetic' | 'testMarked'>): boolean {
  return !realProvider || (facts.synthetic && !facts.testMarked);
}

/**
 * The caller's AI state. `available` carries the model the chat tier resolves to for this organisation right now;
 * `not_configured` carries what is missing. Every other reason is the uniform 404 on the AI routes.
 */
export type AiAvailability =
  | { available: true; model: AiCatalogueModel; source: AiResolutionSource; level: AiLevelResolutionFacts; synthetic: boolean }
  | { available: false; reason: typeof AiUnavailableReason.NOT_CONFIGURED; setup: AiSetupNeededV2 }
  | { available: false; reason: Exclude<AiUnavailableReasonType, typeof AiUnavailableReason.NOT_CONFIGURED> };

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
   * The model this turn runs on, resolved at Worker start with the same resolver as the API (org pin → env default →
   * nearest tier → any available). Re-checked before every step; never re-resolved mid-turn.
   */
  model: AiCatalogueModel;
  /**
   * The model may run for THIS turn: always true for an in-process test model; for a real provider only when the
   * organisation is marked `synthetic_data` and the database is not a disposable test database (EX-1).
   */
  realProviderPermitted: boolean;
  /** C1 / CD-1: the level, effort and per-step output cap the turn resolved to (applied by the runner at the CD-1 wiring). */
  level?: AiLevelResolutionFacts;
}

/** What the per-request and per-step checks need: the ids (+ the turn's model when one is running). */
export type AiActorIds = Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'> & { model?: AiCatalogueModel };

interface AiFacts {
  eligible: boolean;
  organisationEnabled: boolean;
  /** `organisation_ai_setting.synthetic_data` — set only by the dev seed's definer function. */
  synthetic: boolean;
  /** The database carries the disposable-test marker (test-database-guard.ts). */
  testMarked: boolean;
  /** The organisation's pins (`organisation_ai_model_preference`), lookup keys only. */
  pins: AiModelPins;
  /** C1 / CD-1: the same rows keyed by LEVEL (legacy fast/smart rows are level keys), and the model policy row. */
  levelPins: AiLevelPinsFacts;
  policy: AiModelPolicyFacts;
}

/** The tenant context every AI query binds (never platform/owner context). */
export function aiTenantContext(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>): AuthContext {
  return { organisationId: actor.organisationId, workspaceId: actor.workspaceId, userId: actor.userId, role: '', sessionId: actor.sessionId };
}

/**
 * Two-level enablement + AI_USE + eligibility + model resolution, in ONE place, re-run at every point the owner listed
 * (docs/ai/PHASE1_PLAN.md §4): opening/listing/reading (request guard + service), submit, before enqueue, Worker start
 * (`rebuildForWorker`), before each tool is offered (the actor's permission set), immediately before each tool runs
 * and before every model step (`assertStillAllowed`) and while streaming (SSE re-validation).
 *
 * Evaluation ORDER (docs/ai/PHASE1_TWENTY_PLAN.md §6, C4): a later state is disclosed only to a caller who passed every
 * earlier gate, so an outsider, an ineligible user or an org-off user learns nothing about the AI configuration:
 *   1. not an Admin Inspect session                                              → not_permitted    (404)
 *   2. the user holds `ai.use` (server-built security snapshot, never the JWT)  → not_permitted    (404)
 *   3. the session has a workspace (AI is single-workspace)                     → no_workspace     (404)
 *   4. CEO or CURRENT Initial Manager (`core.ai_actor_eligible()`, the RLS predicate on every AI insert) → not_permitted (404)
 *   5. the platform kill switch AI_ENABLED                                      → platform_disabled (404)
 *   6. the organisation's AI switch (default OFF)                               → organisation_disabled (404)
 *   7. a model resolves for the chat tier (approved + in build + keyed + not disabled + environment permits; org pin →
 *      AI_MODELS_DEFAULT_<TIER> → nearest tier → any)                           → not_configured   (503 AI_NOT_CONFIGURED)
 *   8. a REAL provider only for a `synthetic_data` organisation on a non-test database (EX-1)
 *                                                                               → demo_data_only   (403 AI_DEMO_DATA_ONLY)
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

  /** Request-time evaluation (the `GET /ai/availability` answer and the basis of every route's status). */
  async evaluate(ctx: AuthContext): Promise<AiAvailability> {
    if (ctx.inspectedBy) return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    if (!ctx.organisationId || !ctx.security?.effectivePermissions.has(PermissionFlag.AI_USE)) {
      return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    }
    if (!ctx.workspaceId) return { available: false, reason: AiUnavailableReason.NO_WORKSPACE };
    const facts = await this.tenantContext.runInTenantContext({ ...ctx, role: '' }, (m) => this.readFacts(m, ctx.organisationId!));
    return this.decide(facts);
  }

  /** Steps 4–8 of the order above, on facts read under the caller's tenant context. */
  private decide(facts: AiFacts): AiAvailability {
    if (!facts.eligible) return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    if (!this.config.enabled) return { available: false, reason: AiUnavailableReason.PLATFORM_DISABLED };
    if (!facts.organisationEnabled) return { available: false, reason: AiUnavailableReason.ORGANISATION_DISABLED };
    const result = this.config.resolveChat(facts.policy, facts.levelPins, { synthetic: facts.synthetic });
    if (!result.ok) return { available: false, reason: AiUnavailableReason.NOT_CONFIGURED, setup: this.config.levelSetupNeeded(result) };
    const resolved = result.resolution;
    if (!realProviderPermitted(isRealProvider(resolved.model), facts)) return { available: false, reason: AiUnavailableReason.DEMO_DATA_ONLY };
    return { available: true, model: resolved.model, source: resolved.source, level: resolved, synthetic: facts.synthetic };
  }

  /**
   * Layer 2 for every AI service entry point. Rows 3–6 of the plan's table answer the uniform 404; an eligible caller of an
   * enabled organisation learns `AI_NOT_CONFIGURED` (503) or `AI_DEMO_DATA_ONLY` (403). Returns the resolved model.
   */
  async assertAvailable(ctx: AuthContext): Promise<AiCatalogueModel> {
    const state = await this.evaluate(ctx);
    if (state.available) return state.model;
    if (state.reason === AiUnavailableReason.NOT_CONFIGURED) throw new AiNotConfiguredException(state.setup);
    if (state.reason === AiUnavailableReason.DEMO_DATA_ONLY) throw new AiDemoDataOnlyException();
    throw new AiNotAvailableException();
  }

  /**
   * Same checks inside an already-open, tenant-bound transaction (submit path: the check and the inserts share one
   * snapshot). `ai.use` is re-read from the database here, not from the request snapshot. Throws only the uniform 404
   * (the request-level 503/403 was already answered by `assertAvailable`; a change in between is "gone").
   */
  async assertAvailableTx(m: EntityManager, ctx: AuthContext): Promise<AiCatalogueModel> {
    if (ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiNotAvailableException();
    const state = this.decide(await this.readFacts(m, ctx.organisationId));
    if (!state.available) throw new AiNotAvailableException();
    return state.model;
  }

  /**
   * Worker start: rebuild the actor from PostgreSQL only. The job's ids are LOOKUP INPUTS: the session must still be live
   * (read-only check — a background turn never extends an idle session), resolve to the SAME user, organisation and
   * workspace, the account must be active, the organisation not suspended and not in maintenance, every AI gate must
   * still hold, and a model must resolve with the same resolver as the API. Anything else throws AiAccessRevokedError
   * (the turn stops; nothing is sent to any model).
   */
  async rebuildForWorker(input: { organisationId: string; workspaceId: string; userId: string; sessionId: string; level?: AiModelLevel }): Promise<AiActor> {
    if (!this.config.enabled) throw new AiAccessRevokedError('platform_disabled');
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
      const result = this.config.resolveChat(facts.policy, facts.levelPins, { synthetic: facts.synthetic }, input.level);
      if (!result.ok) throw new AiAccessRevokedError(PLATFORM_NOT_READY);
      const resolved = result.resolution;
      if (!realProviderPermitted(isRealProvider(resolved.model), facts)) throw new AiAccessRevokedError(REAL_PROVIDER_NOT_PERMITTED);
      const permissions = new Set<PermissionFlagType>();
      for (const flag of AI_TOOL_PERMISSION_FLAGS) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) permissions.add(flag);
      return { organisationId: input.organisationId, workspaceId: input.workspaceId, userId: input.userId, sessionId: input.sessionId, timezone, permissions, model: resolved.model, realProviderPermitted: true, level: resolved };
    });
  }

  /**
   * Immediately before a tool runs, before every model step, and periodically while a turn or stream is open: the
   * session, account, organisation, every AI gate and — when given — the tool's own permission, re-read in a fresh short
   * transaction. With a running turn's `model`: that model must STILL be usable (key removed, model disabled or approval
   * revoked ⇒ stop) and permitted for this organisation. Without one (SSE): a model must still resolve.
   */
  async assertStillAllowed(actor: AiActorIds, flag?: PermissionFlagType): Promise<void> {
    if (!this.config.enabled) throw new AiAccessRevokedError('platform_disabled');
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
      const chat = actor.model ? null : this.config.resolveChat(facts.policy, facts.levelPins, { synthetic: facts.synthetic });
      const model = actor.model ?? (chat?.ok ? chat.resolution.model : null);
      if (!model || !this.config.isModelUsable(model)) throw new AiAccessRevokedError(PLATFORM_NOT_READY);
      if (!realProviderPermitted(isRealProvider(model), facts)) throw new AiAccessRevokedError(REAL_PROVIDER_NOT_PERMITTED);
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

  /**
   * Eligibility (CEO / current Initial Manager), the organisation switch, the synthetic marker and the organisation's
   * model pins, under the bound tenant context (RLS: the pins table is FORCE RLS, read by the bound organisation only).
   */
  private async readFacts(m: EntityManager, organisationId: string): Promise<AiFacts> {
    const [row] = await m.query<Array<{ eligible: boolean; enabled: boolean | null; synthetic: boolean | null; test_marked: boolean | null; pins: Record<string, unknown> | null; policy: Record<string, unknown> | null }>>(
      `SELECT core.ai_actor_eligible() AS eligible,
              (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled,
              (SELECT s.synthetic_data FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS synthetic,
              -- The DATABASE-level marker from the catalog (test-database-guard.ts): a session or connection-string SET
              -- cannot hide it. Same predicate as core.ai_dev_mark_organisation_synthetic.
              EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
                       WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0 AND cfg = $2) AS test_marked,
              (SELECT jsonb_object_agg(p.tier, p.model_id) FROM core.organisation_ai_model_preference p WHERE p.organisation_id = $1) AS pins,
              (SELECT to_jsonb(mp) - 'organisation_id' - 'updated_by' - 'reason' FROM core.organisation_ai_model_policy mp WHERE mp.organisation_id = $1) AS policy`,
      [organisationId, `${DISPOSABLE_TEST_DATABASE_SETTING}=true`],
    );
    const pins: AiModelPins = {};
    for (const tier of ['fast', 'smart'] as const) {
      const id = row?.pins?.[tier];
      if (typeof id === 'string') pins[tier] = id;
    }
    return {
      eligible: row?.eligible === true,
      organisationEnabled: row?.enabled === true,
      // Anything but an explicit true (no row, NULL) is "not synthetic"; a marker read that is not an explicit false is "test".
      synthetic: row?.synthetic === true,
      testMarked: row?.test_marked !== false,
      pins,
      levelPins: levelPinsFromRows(row?.pins ?? null),
      policy: policyFromRow(row?.policy ?? null),
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
