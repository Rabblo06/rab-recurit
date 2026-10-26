import {
  AI_ASSISTANT_PRESETS,
  AI_DEFAULT_ASSISTANT_PRESET,
  AiAssistantColour,
  AiAssistantFace,
  AiAssistantPreset,
  AiAssistantProfileUpdateRequest,
  AiAssistantProfileView,
  AiAssistantShape,
  PermissionFlag,
} from '@rab/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { returningRows } from './ai-query-rows';

interface ProfileRow {
  preset: string | null;
  name: string;
  shape: string;
  colour: string;
  face: string;
  animate: boolean;
  updated_at: Date | string;
}

/** Control (Cc), format (Cf: zero-width, bidi embeddings/overrides/isolates, BOM, tag characters) and markup characters. */
const NAME_REFUSED = /[\p{Cc}\p{Cf}<>]/u;

/** The default profile (no row stored). */
export function defaultAssistantProfile(): AiAssistantProfileView {
  const p = AI_ASSISTANT_PRESETS[AI_DEFAULT_ASSISTANT_PRESET];
  return { preset: AI_DEFAULT_ASSISTANT_PRESET, name: p.name, shape: p.shape, colour: p.colour, face: p.face, animate: true, isDefault: true, updatedAt: null };
}

function toView(row: ProfileRow): AiAssistantProfileView {
  return {
    preset: (row.preset as AiAssistantPreset | null) ?? null,
    name: row.name,
    shape: row.shape as AiAssistantShape,
    colour: row.colour as AiAssistantColour,
    face: row.face as AiAssistantFace,
    animate: row.animate,
    isDefault: false,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Throws a fixed 400 when the name breaks a presentation rule (length, control / bidi / zero-width / markup characters). */
export function assertAssistantName(name: string): void {
  if (name.length < 1 || name.length > 24 || name.trim() === '' || NAME_REFUSED.test(name)) {
    throw new BadRequestException({ statusCode: 400, code: 'AI_ASSISTANT_NAME_REFUSED', message: 'Use 1–24 letters, numbers, spaces or punctuation.' });
  }
}

/**
 * Settings → AI assistant name and avatar (C1 / TWENTY_UI_CONTRACT_DELTAS CD-3, TW-D4). PRESENTATION ONLY: the name is
 * never sent to a model, never placed in a prompt, always shown with an "AI" badge and rendered as plain text.
 *
 * Five layers for the settings routes: (1) controller JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings);
 * (2) here: Admin Inspect refused, `ai.settings` re-read from PostgreSQL, CEO (`core.ai_settings_writer()`), platform and
 * organisation AI switches (otherwise the uniform 404); (3) organisation-scoped queries; (4) FORCE RLS on
 * `core.organisation_ai_assistant`; (5) writes need `core.ai_settings_writer()` and `updated_by = current_uid()` in RLS.
 * Cosmetic: no step-up, no reason; every write is audited `ai.assistant_profile_changed` with field NAMES and enum values
 * only (never the name text).
 */
@Injectable()
export class AiAssistantService {
  constructor(
    private readonly config: AiConfigService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** For `GET /ai/availability`, inside the caller's own tenant transaction (RLS: the bound organisation's row). */
  async profileTx(m: EntityManager, organisationId: string): Promise<AiAssistantProfileView> {
    const [row] = await m.query<ProfileRow[]>(
      `SELECT preset, name, shape, colour, face, animate, updated_at FROM core.organisation_ai_assistant WHERE organisation_id = $1`,
      [organisationId],
    );
    return row ? toView(row) : defaultAssistantProfile();
  }

  async get(ctx: AuthContext): Promise<AiAssistantProfileView> {
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      return this.profileTx(m, ctx.organisationId!);
    });
  }

  async update(ctx: AuthContext, dto: AiAssistantProfileUpdateRequest): Promise<AiAssistantProfileView> {
    const custom = dto.name !== undefined || dto.shape !== undefined || dto.colour !== undefined || dto.face !== undefined;
    if (dto.preset !== undefined && custom) throw new BadRequestException({ statusCode: 400, code: 'AI_ASSISTANT_INVALID', message: 'Choose a preset or customise it, not both.' });
    if (dto.preset === undefined && !custom && dto.animate === undefined) throw new BadRequestException({ statusCode: 400, code: 'AI_ASSISTANT_INVALID', message: 'Nothing to change.' });
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      const before = await this.profileTx(m, ctx.organisationId!);
      let next: Omit<AiAssistantProfileView, 'isDefault' | 'updatedAt'>;
      if (dto.preset !== undefined) {
        const p = AI_ASSISTANT_PRESETS[dto.preset];
        next = { preset: dto.preset, name: p.name, shape: p.shape, colour: p.colour, face: p.face, animate: dto.animate ?? before.animate };
      } else if (custom) {
        if (dto.name === undefined || dto.shape === undefined || dto.colour === undefined || dto.face === undefined) {
          throw new BadRequestException({ statusCode: 400, code: 'AI_ASSISTANT_INVALID', message: 'A custom assistant needs a name, shape, colour and face.' });
        }
        assertAssistantName(dto.name);
        next = { preset: null, name: dto.name, shape: dto.shape, colour: dto.colour, face: dto.face, animate: dto.animate ?? before.animate };
      } else {
        next = { preset: before.preset, name: before.name, shape: before.shape, colour: before.colour, face: before.face, animate: dto.animate! };
      }
      await m.query(
        `INSERT INTO core.organisation_ai_assistant (organisation_id, preset, name, shape, colour, face, animate, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organisation_id) DO UPDATE SET preset = EXCLUDED.preset, name = EXCLUDED.name, shape = EXCLUDED.shape,
           colour = EXCLUDED.colour, face = EXCLUDED.face, animate = EXCLUDED.animate, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ctx.organisationId, next.preset, next.name, next.shape, next.colour, next.face, next.animate, ctx.userId],
      );
      const changed = (['preset', 'name', 'shape', 'colour', 'face', 'animate'] as const).filter((k) => before[k] !== next[k]);
      await this.audit.record(m, ctx, AuditAction.AI_ASSISTANT_PROFILE_CHANGED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        // Field names + enum values only; the free-text name is never copied into the audit log.
        metadata: { changed, preset: next.preset, shape: next.shape, colour: next.colour, face: next.face, animate: next.animate, reset: false },
      });
      return this.profileTx(m, ctx.organisationId!);
    });
  }

  /** "Reset to default": removes the row. */
  async reset(ctx: AuthContext): Promise<AiAssistantProfileView> {
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      // DELETE … RETURNING is answered as [rows, count] by TypeORM: always read it through returningRows().
      const rows = await returningRows<{ organisation_id: string }>(m, `DELETE FROM core.organisation_ai_assistant WHERE organisation_id = $1 RETURNING organisation_id`, [ctx.organisationId]);
      if (rows.length > 0) {
        await this.audit.record(m, ctx, AuditAction.AI_ASSISTANT_PROFILE_CHANGED, { entityType: 'organisation', entityId: ctx.organisationId!, metadata: { changed: [], reset: true } });
      }
      return defaultAssistantProfile();
    });
  }

  private bound(ctx: AuthContext): AuthContext {
    if (ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    return { ...ctx, role: '' };
  }

  /** Layer 2 (same rule as AiModelSettingsService): 403 without `ai.settings`; non-CEO / AI off → the uniform 404. */
  private async authorizeTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    if (ctx.inspectedBy) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_SETTINGS))) {
      // Batch 3: the uniform 404, like every other refusal of the settings gate (a 403 would confirm the settings exist).
      throw new AiNotAvailableException();
    }
    const [row] = await m.query<Array<{ writer: boolean; enabled: boolean | null }>>(
      `SELECT core.ai_settings_writer() AS writer, (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled`,
      [ctx.organisationId],
    );
    if (row?.writer !== true || !this.config.enabled || row.enabled !== true) throw new AiNotAvailableException();
  }
}
