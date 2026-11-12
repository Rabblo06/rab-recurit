import type { SecurityAuditEvent } from '../audit-sink/security-audit-sink';
import { classifyAuditAction, LOGIN_FAILED_EVENT_TYPE } from './security-audit-event-catalogue';

/**
 * Phase X Part 2, X1.1: the event a sink receives, built from data that already exists AFTER the action (Twenty's
 * event-logs: build-event-envelope.ts builds the envelope from the action's own result). Pure.
 *
 * Redaction happens twice:
 *  - here: only identifiers, the action, its category and severity, timestamps and the row's own `metadata` (which the
 *    AuditService contract already keeps free of passwords, tokens, token hashes and MFA secrets); a login-failure e-mail
 *    is masked before it leaves this function, and anything that is not an e-mail shape is replaced (a password typed into
 *    the e-mail field must never be shipped);
 *  - in the sink (security-audit-sink.ts `formatSecurityAuditEvent`, always): keys that look like secrets (password,
 *    secret, token, hash, totp, recovery, cookie, authorization, api key, credential, signature, otp) become
 *    "[REDACTED]", e-mail addresses anywhere in a string are masked, postgres URLs are replaced, strings are cut at 256
 *    characters, nesting at depth 3, 50 keys.
 */

/** The `core.audit_log` columns the Worker re-reads (snake_case, as `manager.query` returns them). */
export interface AuditLogShippingRow {
  id: string;
  organisation_id: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown;
  created_at: Date | string;
}

const iso = (value: Date | string): string | null => {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The sink event for a committed audit row, or null when its action is not in the security catalogue. */
export function buildAuditRowSecurityEvent(row: AuditLogShippingRow, processLabel: string): SecurityAuditEvent | null {
  const classification = classifyAuditAction(row.action);
  if (!classification) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
  return {
    type: row.action,
    severity: classification.severity,
    process: processLabel,
    organisationId: row.organisation_id,
    actorUserId: row.actor_user_id,
    detail: {
      category: classification.category,
      source: 'audit_log',
      auditLogId: row.id,
      recordedAt: iso(row.created_at),
      targetUserId: row.target_user_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      metadata,
    },
  };
}

const EMAIL_SHAPE = /^([^\s@])[^\s@]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;

/** `a***@example.com` for an e-mail shape; `[not-an-email]` for anything else (never the raw input). */
export function maskEmailForAudit(raw: unknown): string {
  if (typeof raw !== 'string') return '[none]';
  const value = raw.trim().toLowerCase();
  if (!value) return '[none]';
  const m = EMAIL_SHAPE.exec(value);
  return m ? `${m[1]}***@${m[2]!.slice(0, 128)}` : '[not-an-email]';
}

export type LoginFailureReason = 'invalid_credentials' | 'ambiguous_accounts' | 'provider_sign_in_refused';

/** The pre-authentication login failure: no organisation, no user id (the response is uniform; so is this event). */
export function buildLoginFailedSecurityEvent(input: { email: unknown; reason: LoginFailureReason; provider: string; detailReason?: string }, processLabel: string): SecurityAuditEvent {
  return {
    type: LOGIN_FAILED_EVENT_TYPE,
    severity: 'warning',
    process: processLabel,
    organisationId: null,
    actorUserId: null,
    detail: {
      category: 'login',
      source: 'login_history',
      reason: input.reason,
      ...(input.detailReason ? { providerReason: String(input.detailReason).slice(0, 64) } : {}),
      provider: String(input.provider).slice(0, 32),
      email: maskEmailForAudit(input.email),
    },
  };
}
