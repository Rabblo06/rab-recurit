import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export const OUTBOX_KINDS = ['email', 'push', 'realtime', 'worker_event'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** `GET /rest/v1/admin/outbox/failed` — filters only; no field here can widen what a platform admin may see. */
export class FailedOutboxQueryDto {
  @IsOptional()
  @IsIn(OUTBOX_KINDS)
  kind?: OutboxKind;

  /** Target organisation (platform-admin target selection, like `organisations/:organisationId/suspend`). */
  @IsOptional()
  @IsUUID('all')
  organisationId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** `POST /rest/v1/admin/outbox/organisations/:organisationId/emails/:emailId/replay`. */
export class ReplayFailedEmailDto {
  /**
   * Replay a row the dispatcher marked DELIVERY_UNCERTAIN (the provider may already have sent it). Default false: such a
   * row is refused with 409 so an operator must consciously accept a possible duplicate.
   */
  @IsOptional()
  @Transform(({ value }) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : value))
  @IsBoolean()
  allowUncertain?: boolean;

  /**
   * Admin Panel: why the email is being replayed (3–500 characters). Optional for older callers; when present it is
   * recorded as an `admin.email_replay_reason` audit row in the SAME transaction as the replay itself.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
