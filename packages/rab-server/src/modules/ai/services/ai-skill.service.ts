import { createHash } from 'node:crypto';

import {
  AI_SKILL_LIMITS,
  AI_SKILL_NAME_PATTERN,
  AiSkillCreateRequest,
  AiSkillSettingsView,
  AiSkillSummaryView,
  AiSkillUpdateRequest,
  AiSkillView,
} from '@rab/shared';
import { HttpException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditActionType, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiLoadedSkill, AiLoadSkillsResult, AiSkillCatalogueLine, AiSkillReader } from '../contracts/skills';
import { AiNotAvailableException, AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import {
  AiSkillContentRefusedException,
  AiSkillLimitReachedException,
  AiSkillNameTakenException,
  AiSkillNotAvailableException,
  AiSkillNothingToChangeException,
  AiSkillReasonRequiredException,
} from '../exceptions/ai-skill.exceptions';
import { AI_BUILTIN_SKILLS, AiBuiltinSkill, builtinSkill, isBuiltinSkillName } from '../skills/builtin-skills';
import { skillContentRefusals } from '../skills/skill-content-rules';
import { guardSkillContent, guardSkillLine } from '../tools/ai-skill-guard';
import { AiAccessService, AiActor, aiTenantContext } from './ai-access.service';
import { AiSettingsAuthority } from './ai-settings-authority.service';

/** The one step-up action of every skill write, toggles included (P4-D4). */
export const AI_SKILL_STEP_UP_ACTION = 'organisation.ai.skill.update' as const;
/** The trigger `core.ai_skill_limit_guard()` raises this constraint name at the 51st custom skill. */
export const AI_SKILL_LIMIT_CONSTRAINT = 'ai_skill_custom_limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** A skill an action names: a custom skill by id, or a built-in by name. */
export type AiSkillRef = { id: string } | { builtin: string };

interface SkillRow {
  id: string;
  name: string;
  is_system: boolean;
  label: string | null;
  description: string | null;
  content: string | null;
  is_active: boolean;
  updated_at: Date | string;
}

const iso = (value: Date | string) => new Date(value).toISOString();

/**
 * AI Phase 4 — organisation skills (docs/ai/PHASE4_TWENTY_PLAN.md §2, P4-D1…D10, XD-4). Skills are INSTRUCTIONS ONLY:
 * they grant no permission and no tool. This service never imports the tool registry, the tool definitions or
 * `PermissionsService` (G1, static test T4-X1); the actor's tool set is built from PostgreSQL before any skill is read.
 *
 * Five layers on every write (CLAUDE.md, §2.6):
 *   1. controller: JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings);
 *   2. HERE: Admin Inspect refused, `ai.settings` re-read, the CEO only, both AI switches (AiSettingsAuthority, inside the
 *      transaction, again after the step-up), a recent step-up `organisation.ai.skill.update`, a reason of 3–500
 *      characters, the write-time content rules, the 50-custom-skill limit (a clean 409 before the trigger), and the audit
 *      row in the same transaction (name, id, content length and SHA-256 — never the content);
 *   3. every query is scoped to the caller's organisation;
 *   4. RLS (FORCE) on `core.ai_skill`: the bound organisation, read only by an AI-eligible user;
 *   5. INSERT/UPDATE/DELETE additionally `core.ai_settings_writer()` (CEO) and `updated_by = core.current_uid()`; DELETE
 *      never a built-in's row. A refused write (42501) is answered as 404.
 *
 * The reader side (`AiSkillReader`: catalogue, load, tag check) runs each call in its own short, READ ONLY tenant
 * transaction as the actor; with no eligible user bound, RLS returns nothing and every built-in is treated as unavailable
 * too (fail closed).
 */
@Injectable()
export class AiSkillService implements AiSkillReader {
  constructor(
    private readonly authority: AiSettingsAuthority,
    private readonly access: AiAccessService,
    private readonly stepUp: StepUpReauthService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // ── Settings → AI → Skills (CEO + ai.settings) ────────────────────────────────────────────────────────────────────

  async listForSettings(ctx: AuthContext): Promise<AiSkillSettingsView> {
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authority.assertSettingsWriterTx(m, ctx);
      return this.settingsView(m, ctx.organisationId!);
    });
  }

  async create(ctx: AuthContext, input: AiSkillCreateRequest): Promise<AiSkillSettingsView> {
    await this.authorizeWrite(ctx, input?.reason);
    const fields = { name: input.name, label: input.label, description: input.description, content: input.content };
    this.assertContent(fields);
    if (isBuiltinSkillName(input.name)) throw new AiSkillNameTakenException();
    return this.writeTx(ctx, async (m, organisationId) => {
      // The same advisory lock the trigger takes: concurrent creates of one organisation are serialised, so the count is
      // exact and the 51st gets this clean 409 (the trigger stays the database-level backstop).
      await m.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_skill:' || $1::uuid::text, 0))`, [organisationId]);
      const [{ n }] = await m.query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM core.ai_skill WHERE organisation_id = $1 AND NOT is_system`, [organisationId]);
      if (n >= AI_SKILL_LIMITS.maxCustomPerOrganisation) throw new AiSkillLimitReachedException();
      const [taken] = await m.query<Array<{ id: string }>>(`SELECT id FROM core.ai_skill WHERE organisation_id = $1 AND name = $2`, [organisationId, input.name]);
      if (taken) throw new AiSkillNameTakenException();
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.ai_skill (organisation_id, name, is_system, label, description, content, is_active, created_by, updated_by, reason)
         VALUES ($1, $2, false, $3, $4, $5, true, $6, $6, $7) RETURNING id`,
        [organisationId, input.name, input.label, input.description, input.content, ctx.userId, input.reason],
      );
      await this.auditWrite(m, ctx, AuditAction.AI_SKILL_CREATED, row!.id, { name: input.name, isSystem: false, ...this.contentFacts(input.content), reason: input.reason });
    });
  }

  async update(ctx: AuthContext, id: string, input: AiSkillUpdateRequest): Promise<AiSkillSettingsView> {
    await this.authorizeWrite(ctx, input?.reason);
    if (!UUID.test(String(id))) throw new AiRecordNotFoundException();
    const changes = { label: input.label, description: input.description, content: input.content };
    const changed = (Object.keys(changes) as Array<keyof typeof changes>).filter((k) => changes[k] !== undefined);
    if (changed.length === 0) throw new AiSkillNothingToChangeException();
    this.assertContent(changes);
    return this.writeTx(ctx, async (m, organisationId) => {
      const before = await this.lockCustom(m, organisationId, id);
      const label = input.label ?? before.label!;
      const description = input.description ?? before.description!;
      const content = input.content ?? before.content!;
      await m.query(
        `UPDATE core.ai_skill SET label = $3, description = $4, content = $5, updated_by = $6, reason = $7, updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND NOT is_system`,
        [id, organisationId, label, description, content, ctx.userId, input.reason],
      );
      await this.auditWrite(m, ctx, AuditAction.AI_SKILL_UPDATED, id, {
        name: before.name,
        isSystem: false,
        changed,
        ...this.contentFacts(content),
        previousContentSha256: sha256(before.content ?? ''),
        reason: input.reason,
      });
    });
  }

  async activate(ctx: AuthContext, ref: AiSkillRef, reason: string): Promise<AiSkillSettingsView> {
    return this.setActive(ctx, ref, true, reason);
  }

  async deactivate(ctx: AuthContext, ref: AiSkillRef, reason: string): Promise<AiSkillSettingsView> {
    return this.setActive(ctx, ref, false, reason);
  }

  /** Deletes a CUSTOM skill. A built-in is switched off, never removed (no route, and RLS refuses it). */
  async remove(ctx: AuthContext, id: string, reason: string): Promise<AiSkillSettingsView> {
    await this.authorizeWrite(ctx, reason);
    if (!UUID.test(String(id))) throw new AiRecordNotFoundException();
    return this.writeTx(ctx, async (m, organisationId) => {
      const before = await this.lockCustom(m, organisationId, id);
      const deleted = await m.query<[unknown[], number]>(`DELETE FROM core.ai_skill WHERE id = $1 AND organisation_id = $2 AND NOT is_system RETURNING id`, [id, organisationId]);
      if (deleted[1] !== 1) throw new AiRecordNotFoundException();
      await this.auditWrite(m, ctx, AuditAction.AI_SKILL_DELETED, id, { name: before.name, isSystem: false, ...this.contentFacts(before.content ?? ''), reason });
    });
  }

  // ── Chat side (`GET /ai/skills`, behind AiAvailableGuard): active skills' name/label/description only ─────────────

  async listForChat(ctx: AuthContext): Promise<AiSkillSummaryView[]> {
    await this.access.assertAvailable(ctx);
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      return activeSummaries(await this.readableRows(m, ctx.organisationId!));
    });
  }

  // ── AiSkillReader (runner at 4w, prompt preview in Phase 8) ───────────────────────────────────────────────────────

  async catalogueFor(actor: AiActor): Promise<readonly AiSkillCatalogueLine[]> {
    return this.readAs(actor, async (rows) => activeSummaries(rows).map(({ name, description }) => ({ name, description })));
  }

  async load(actor: AiActor, names: readonly string[], remainingChars: number): Promise<AiLoadSkillsResult> {
    const wanted = validNames(names, AI_SKILL_LIMITS.maxPerLoad);
    if (!wanted) throw new Error('load_skills: 1..3 distinct names matching AI_SKILL_NAME_PATTERN are required');
    return this.readAs(actor, async (rows) => {
      const skills: AiLoadedSkill[] = [];
      const missing: string[] = [];
      for (const name of wanted) {
        const found = rows === null ? null : resolveActive(rows, name);
        if (found) skills.push({ name, label: guardSkillLine(found.label), content: guardSkillContent(found.content) });
        else missing.push(name);
      }
      const chars = skills.reduce((sum, s) => sum + s.content.length, 0);
      if (chars > Math.max(0, remainingChars)) return { error: 'skill_budget_exceeded' as const };
      return { skills, missing };
    });
  }

  /** CD-8 (`GET /ai/capabilities`): the active skills' name/label/description, sorted (no content). Caller gates availability. */
  async summariesFor(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>): Promise<AiSkillSummaryView[]> {
    return this.readAs(actor, async (rows) => activeSummaries(rows));
  }

  /** CD-10 (Settings → AI overview counts): how many skills are active for this organisation (built-ins + custom). */
  async countActive(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>): Promise<number> {
    return this.readAs(actor, async (rows) => activeSummaries(rows).length);
  }

  async assertTaggable(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>, names: readonly string[]): Promise<void> {
    if (Array.isArray(names) && names.length === 0) return;
    const wanted = validNames(names, AI_SKILL_LIMITS.maxTaggedPerMessage);
    if (!wanted) throw new AiSkillNotAvailableException();
    const ok = await this.readAs(actor, async (rows) => rows !== null && wanted.every((name) => resolveActive(rows, name) !== null));
    if (!ok) throw new AiSkillNotAvailableException();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private async setActive(ctx: AuthContext, ref: AiSkillRef, active: boolean, reason: string): Promise<AiSkillSettingsView> {
    await this.authorizeWrite(ctx, reason);
    const action = active ? AuditAction.AI_SKILL_ACTIVATED : AuditAction.AI_SKILL_DEACTIVATED;
    if ('builtin' in ref) {
      const builtin = builtinSkill(String(ref.builtin));
      if (!builtin) throw new AiRecordNotFoundException();
      return this.writeTx(ctx, async (m, organisationId) => {
        const [before] = await m.query<Array<{ is_active: boolean }>>(`SELECT is_active FROM core.ai_skill WHERE organisation_id = $1 AND name = $2 AND is_system FOR UPDATE`, [organisationId, builtin.name]);
        const [row] = await m.query<Array<{ id: string }>>(
          `INSERT INTO core.ai_skill (organisation_id, name, is_system, is_active, created_by, updated_by, reason)
           VALUES ($1, $2, true, $3, $4, $4, $5)
           ON CONFLICT (organisation_id, name) DO UPDATE SET is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason, updated_at = now()
           RETURNING id`,
          [organisationId, builtin.name, active, ctx.userId, reason],
        );
        await this.auditWrite(m, ctx, action, row!.id, { name: builtin.name, isSystem: true, from: before?.is_active ?? true, to: active, ...this.contentFacts(builtin.content), reason });
      });
    }
    const id = String(ref.id);
    if (!UUID.test(id)) throw new AiRecordNotFoundException();
    return this.writeTx(ctx, async (m, organisationId) => {
      const before = await this.lockCustom(m, organisationId, id);
      await m.query(`UPDATE core.ai_skill SET is_active = $3, updated_by = $4, reason = $5, updated_at = now() WHERE id = $1 AND organisation_id = $2 AND NOT is_system`, [
        id,
        organisationId,
        active,
        ctx.userId,
        reason,
      ]);
      await this.auditWrite(m, ctx, action, id, { name: before.name, isSystem: false, from: before.is_active, to: active, ...this.contentFacts(before.content ?? ''), reason });
    });
  }

  /**
   * Authorisation first (a stranger learns nothing and is not asked to step up), then the step-up, then the reason.
   * Content rules come after this, in the public method.
   */
  private async authorizeWrite(ctx: AuthContext, reason: unknown): Promise<void> {
    await this.tenantContext.runInTenantContext(this.bound(ctx), (m) => this.authority.assertSettingsWriterTx(m, ctx));
    await this.stepUp.assertRecentStepUp(ctx, AI_SKILL_STEP_UP_ACTION);
    if (typeof reason !== 'string' || reason.trim().length < AI_SKILL_LIMITS.reasonMinChars || reason.length > AI_SKILL_LIMITS.reasonMaxChars) {
      throw new AiSkillReasonRequiredException();
    }
  }

  private assertContent(fields: Record<string, unknown>): void {
    const refusals = skillContentRefusals(fields);
    if (refusals.length > 0) throw new AiSkillContentRefusedException(refusals);
  }

  /** The write transaction: authorisation re-checked inside it, the write, its audit row, then the fresh view. */
  private async writeTx(ctx: AuthContext, write: (m: EntityManager, organisationId: string) => Promise<void>): Promise<AiSkillSettingsView> {
    try {
      return await this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
        await this.authority.assertSettingsWriterTx(m, ctx);
        await write(m, ctx.organisationId!);
        return this.settingsView(m, ctx.organisationId!);
      });
    } catch (error) {
      throw mapWriteError(error);
    }
  }

  /** A custom skill of the organisation, locked for the write; anything else (absent, foreign, a built-in row) is 404. */
  private async lockCustom(m: EntityManager, organisationId: string, id: string): Promise<SkillRow> {
    const [row] = await m.query<SkillRow[]>(
      `SELECT id, name, is_system, label, description, content, is_active, updated_at FROM core.ai_skill WHERE id = $1 AND organisation_id = $2 AND NOT is_system FOR UPDATE`,
      [id, organisationId],
    );
    if (!row) throw new AiRecordNotFoundException();
    return row;
  }

  private contentFacts(content: string): { contentLength: number; contentSha256: string } {
    return { contentLength: content.length, contentSha256: sha256(content) };
  }

  private async auditWrite(m: EntityManager, ctx: AuthContext, action: AuditActionType, skillId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit.record(m, ctx, action, { entityType: 'ai_skill', entityId: skillId, metadata: { skillId, ...metadata } });
  }

  private async settingsView(m: EntityManager, organisationId: string): Promise<AiSkillSettingsView> {
    const rows = await m.query<SkillRow[]>(
      `SELECT id, name, is_system, label, description, content, is_active, updated_at FROM core.ai_skill WHERE organisation_id = $1 ORDER BY name`,
      [organisationId],
    );
    const skills: AiSkillView[] = AI_BUILTIN_SKILLS.map((b) => {
      const row = rows.find((r) => r.is_system && r.name === b.name);
      return {
        id: row?.id ?? null,
        name: b.name,
        label: b.label,
        description: b.description,
        isSystem: true,
        isActive: row ? row.is_active : true,
        // S10 (Batch 3, Agent 9): the built-in's text, READ-ONLY — the very code string load_skills serves
        // (builtin-skills.ts, no second copy). Only this CEO settings view carries it; `isSystem` stays toggle-only and the
        // composer's tag menu (`listForChat` / `summariesFor`) still returns no content.
        content: b.content,
        contentLength: b.content.length,
        updatedAt: row ? iso(row.updated_at) : null,
      };
    });
    const custom = rows.filter((r) => !r.is_system);
    for (const r of custom) {
      skills.push({
        id: r.id,
        name: r.name,
        label: r.label ?? '',
        description: r.description ?? '',
        isSystem: false,
        isActive: r.is_active,
        content: r.content ?? '',
        contentLength: (r.content ?? '').length,
        updatedAt: iso(r.updated_at),
      });
    }
    return { skills, customCount: custom.length, limits: AI_SKILL_LIMITS };
  }

  /** The organisation's skill rows as the bound user may read them, or null when the user is not AI-eligible. */
  private async readableRows(m: EntityManager, organisationId: string): Promise<SkillRow[] | null> {
    const [{ eligible }] = await m.query<Array<{ eligible: boolean }>>(`SELECT core.ai_actor_eligible() AS eligible`);
    if (eligible !== true) return null;
    return m.query<SkillRow[]>(
      `SELECT id, name, is_system, label, description, content, is_active, updated_at FROM core.ai_skill WHERE organisation_id = $1`,
      [organisationId],
    );
  }

  /** One short READ ONLY tenant transaction as the actor (never platform/owner context, never across a model call). */
  private async readAs<T>(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>, fn: (rows: SkillRow[] | null) => Promise<T>): Promise<T> {
    const ctx = aiTenantContext(actor);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      return fn(await this.readableRows(m, actor.organisationId));
    });
  }

  /** The caller's own tenant context (never platform/owner context); Admin Inspect is refused before anything. */
  private bound(ctx: AuthContext): AuthContext {
    if (!ctx || ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    return { ...ctx, role: '' };
  }
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The active skills (built-ins without an "off" row + active custom skills) as the tag menu shows them; null rows ⇒ none. */
function activeSummaries(rows: readonly SkillRow[] | null): AiSkillSummaryView[] {
  if (rows === null) return [];
  const out: AiSkillSummaryView[] = [];
  for (const b of AI_BUILTIN_SKILLS) if (builtinActive(rows, b.name)) out.push({ name: b.name, label: b.label, description: b.description });
  for (const r of rows) if (!r.is_system && r.is_active) out.push({ name: r.name, label: r.label ?? r.name, description: r.description ?? '' });
  return out.sort(byName);
}

/** No row = active (P4-D2); a toggle row decides otherwise. */
function builtinActive(rows: readonly SkillRow[], name: string): boolean {
  const row = rows.find((r) => r.is_system && r.name === name);
  return row ? row.is_active : true;
}

/** An ACTIVE skill readable by the bound user: a built-in (code text) or a custom row. */
function resolveActive(rows: readonly SkillRow[], name: string): { label: string; content: string } | null {
  const builtin: AiBuiltinSkill | null = builtinSkill(name);
  if (builtin) return builtinActive(rows, name) ? { label: builtin.label, content: builtin.content } : null;
  const row = rows.find((r) => !r.is_system && r.name === name);
  return row && row.is_active && row.content ? { label: row.label ?? name, content: row.content } : null;
}

/** 1..max distinct names, each matching AI_SKILL_NAME_PATTERN; otherwise null. */
function validNames(names: readonly string[], max: number): string[] | null {
  if (!Array.isArray(names) || names.length < 1 || names.length > max) return null;
  if (!names.every((n) => typeof n === 'string' && AI_SKILL_NAME_PATTERN.test(n))) return null;
  if (new Set(names).size !== names.length) return null;
  return [...names];
}

/** Database refusals of a write, answered with the same fixed shapes as the service's own checks. */
function mapWriteError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  const driver = (error as { driverError?: { code?: string; constraint?: string } })?.driverError ?? (error as { code?: string; constraint?: string });
  switch (driver?.code) {
    case '23505':
      return new AiSkillNameTakenException();
    case '23514':
      return driver.constraint === AI_SKILL_LIMIT_CONSTRAINT ? new AiSkillLimitReachedException() : new AiSkillContentRefusedException(['length']);
    case '42501':
      // RLS (layer 4/5) refused a write the service let through: answered as "not found", never as "forbidden".
      return new AiRecordNotFoundException();
    default:
      return error;
  }
}
