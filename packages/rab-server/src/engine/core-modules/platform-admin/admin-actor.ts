import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { AuthContext } from '../tenant/auth-context.interface';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Layer 2 for every Admin Panel service (CLAUDE.md §5.2/§5.7): the controllers already carry `JwtAuthGuard +
 * PlatformAdminGuard`, but a service is also reachable from jobs, CLIs and other services that never pass a guard, so each
 * service method re-checks the actor here. A check that throws denies (fail closed).
 */
export async function assertActivePlatformAdmin(platformAdmin: PlatformAdminService, actor: Pick<AuthContext, 'userId'>): Promise<void> {
  let allowed = false;
  try {
    allowed = Boolean(actor?.userId) && (await platformAdmin.isPlatformAdmin(actor));
  } catch {
    allowed = false;
  }
  if (!allowed) throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
}

/**
 * Admin Inspect is read-only (JwtAuthGuard already refuses unsafe methods under the inspect header); every MUTATION in
 * the panel's services refuses an inspect context again so a direct service caller can never act as an inspected user.
 */
export function refuseInspection(ctx: Pick<AuthContext, 'inspectedBy'>): void {
  if (ctx.inspectedBy) {
    throw new ForbiddenException({ code: 'INSPECT_READ_ONLY', message: 'Admin Inspect is read-only. End the inspect session to make changes.' });
  }
}

export const ADMIN_REASON_MIN = 3;
export const ADMIN_REASON_MAX = 500;

/** Layer 2 for the reason too (the DTO trims and bounds it; a direct caller has no DTO). */
export function requireReason(reason: unknown): string {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value.length < ADMIN_REASON_MIN || value.length > ADMIN_REASON_MAX) {
    throw new BadRequestException({ code: 'ADMIN_REASON_REQUIRED', message: `Give a reason (${ADMIN_REASON_MIN}–${ADMIN_REASON_MAX} characters). It is saved to the audit log.` });
  }
  return value;
}

/** An optional reason (existing routes whose callers predate the panel): validated when present, else undefined. */
export function optionalReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null || (typeof reason === 'string' && reason.trim() === '')) return undefined;
  return requireReason(reason);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Keyset cursor `<iso timestamp>|<uuid>` as base64url. Anything else (tampered, truncated) is a 400, never a guess. */
export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  const invalid = () => new BadRequestException({ code: 'INVALID_CURSOR', message: 'This page link is not valid. Reload the list.' });
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw invalid();
  const [iso, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso ?? '');
  if (extra !== undefined || !isUuid(id) || Number.isNaN(at.getTime()) || at.toISOString() !== iso) throw invalid();
  return { at, id };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}

/** Postgres SQLSTATE 42501 from an admin_* function (the definer's own gate) → 403, never a 500. */
export function mapAdminFunctionError(error: unknown): never {
  const code = (error as { code?: string; driverError?: { code?: string } })?.code ?? (error as { driverError?: { code?: string } })?.driverError?.code;
  if (code === '42501') throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
  if (code === '22023') throw new BadRequestException('Please check the details and try again.');
  throw error;
}
