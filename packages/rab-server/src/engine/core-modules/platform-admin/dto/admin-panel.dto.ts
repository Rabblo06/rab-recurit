import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import { ADMIN_TIMELINE_ACTIONS } from '../admin-panel-audit-actions';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Crewflow Platform Admin Panel DTOs. `forbidNonWhitelisted: true` is global (main.ts): a body or query carrying any
 * field not declared here — `organisationId`, `status`, `userId` … — is a 400, never a hint (CLAUDE.md).
 */

/**
 * A body that must be EMPTY (e.g. "Send test email to me": there is no recipient field). With the global
 * `forbidNonWhitelisted`, any property — `to`, `organisationId`, … — is a 400 instead of being silently ignored.
 */
export class AdminEmptyBodyDto {}

/** Every new admin mutation names WHY. Stored in the audit log (actor organisation and, where there is one, the target's). */
export class AdminReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export const ADMIN_USER_ROLE_FILTERS = ['ceo', 'org_admin', 'manager', 'venue_manager', 'staff', 'platform_admin'] as const;

/** `GET /admin/users/search?q=` — empty = the most recent users; otherwise 3–200 characters (email, name prefix or user id). */
export class AdminUserSearchQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;

  /** User security table role filter: a system role key, or `platform_admin`. */
  @IsOptional()
  @IsIn(ADMIN_USER_ROLE_FILTERS)
  role?: (typeof ADMIN_USER_ROLE_FILTERS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;
}

/** `GET /admin/lookup/organisations?q=` — name, slug or organisation id. */
export class AdminOrganisationSearchQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;
}

export const ADMIN_JOB_STATES = ['failed', 'active', 'waiting', 'delayed', 'completed'] as const;
export type AdminJobState = (typeof ADMIN_JOB_STATES)[number];

export class AdminQueueJobsQueryDto {
  @IsIn(ADMIN_JOB_STATES)
  state!: AdminJobState;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** BullMQ job ids are opaque strings; only this charset is accepted (no globs, no Lua-significant characters). */
export const JOB_ID_PATTERN = /^[A-Za-z0-9:._-]{1,200}$/;

export class AdminQueueJobsActionDto extends AdminReasonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(JOB_ID_PATTERN, { each: true })
  jobIds!: string[];
}

/** Health chart ranges (mockup: 1H / 4H / 12H / 1D / 7D). Anything else is a 400. */
export const ADMIN_METRICS_RANGES = ['1H', '4H', '12H', '1D', '7D'] as const;
export type AdminMetricsRange = (typeof ADMIN_METRICS_RANGES)[number];

export class AdminQueueMetricsQueryDto {
  @IsOptional()
  @IsIn(ADMIN_METRICS_RANGES)
  range?: AdminMetricsRange;
}

export class AdminAuditQueryDto {
  @IsOptional()
  @IsIn(ADMIN_TIMELINE_ACTIONS as string[])
  action?: string;

  /** Filter by admin or target: a user id (the UI resolves a typed name/email through the user search first). */
  @IsOptional()
  @IsUUID('all')
  user?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export const WORKSPACE_SCHEMA_STATUSES = ['CREATING', 'READY', 'MIGRATING', 'FAILED', 'SUPERSEDED'] as const;

export class AdminWorkspacesQueryDto {
  @IsOptional()
  @IsIn(WORKSPACE_SCHEMA_STATUSES)
  status?: (typeof WORKSPACE_SCHEMA_STATUSES)[number];

  /** Platform-admin TARGET selector (like `organisations/:organisationId/suspend`), never the caller's tenant context. */
  @IsOptional()
  @IsUUID('all')
  organisationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * `POST /admin/organisations/:id/reactivate` — a required reason (T1, owner decision). No inline password: the service
 * requires a recent step-up of this session ('organisation.reactivate').
 */
export class ReactivateOrganisationDto extends AdminReasonDto {}
