import type { SecurityAuditSink } from '../audit-sink/security-audit-sink';

/**
 * Owner decision 2 (2026-11-21): platform administrators must use MFA in production (AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true).
 * Review of #327 (fail closed): a production process (API and Worker share the validation) refuses to boot with the switch
 * off, unless the operator sets the break-glass override AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE to a written reason of at
 * least PLATFORM_ADMIN_MFA_OVERRIDE_MIN_REASON characters. The API logs and audits an active override at every start
 * (reportPlatformAdminMfaOverride). The override never turns enforcement OFF by itself: it only lets a process whose switch
 * is already off start. Pure except reportPlatformAdminMfaOverride (log + sink).
 */
export const PLATFORM_ADMIN_MFA_OVERRIDE_KEY = 'AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE';
export const PLATFORM_ADMIN_MFA_OVERRIDE_MIN_REASON = 20;
export const PLATFORM_ADMIN_MFA_OVERRIDE_EVENT_TYPE = 'security.mfa.platform_admin_enforcement_overridden';

export interface PlatformAdminMfaSettings {
  AUTH_MFA_ENFORCE_PLATFORM_ADMIN?: boolean;
  AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE?: string;
}

function overrideReason(env: PlatformAdminMfaSettings): string {
  return typeof env.AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE === 'string' ? env.AUTH_MFA_PLATFORM_ADMIN_OVERRIDE_UNSAFE.trim() : '';
}

/** True when enforcement is off AND a valid override reason is present (the only way such a production process starts). */
export function platformAdminMfaOverrideActive(env: PlatformAdminMfaSettings): boolean {
  return env.AUTH_MFA_ENFORCE_PLATFORM_ADMIN !== true && overrideReason(env).length >= PLATFORM_ADMIN_MFA_OVERRIDE_MIN_REASON;
}

/** The production refusal, or null. Names the variables only, never the reason text. */
export function platformAdminMfaProductionProblem(env: PlatformAdminMfaSettings): string | null {
  if (env.AUTH_MFA_ENFORCE_PLATFORM_ADMIN === true) return null;
  if (platformAdminMfaOverrideActive(env)) return null;
  return (
    'AUTH_MFA_ENFORCE_PLATFORM_ADMIN must be true in production (owner decision 2, 2026-11-21: platform administrators must use MFA). ' +
    `Set AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true. Break-glass only: ${PLATFORM_ADMIN_MFA_OVERRIDE_KEY}=<a written reason of at least ` +
    `${PLATFORM_ADMIN_MFA_OVERRIDE_MIN_REASON} characters> lets the process start with it off; it is logged and audited at every start.`
  );
}

/**
 * At API start, after the security audit sink exists: when the override is active in production, one WARNING log line and
 * one critical `security.mfa.platform_admin_enforcement_overridden` event to the external audit sink (the reason is sent,
 * truncated to 200 characters; the sink redacts secret-shaped text). Returns whether it reported. Fail closed: when the
 * event cannot be written (the sink throws under its `refuse` failure policy) this throws, and main.ts refuses the start.
 */
export async function reportPlatformAdminMfaOverride(input: {
  env: PlatformAdminMfaSettings;
  production: boolean;
  sink: SecurityAuditSink;
  processLabel: string;
  log: (line: string) => void;
}): Promise<boolean> {
  if (!input.production || !platformAdminMfaOverrideActive(input.env)) return false;
  const reason = overrideReason(input.env).slice(0, 200);
  input.log(
    `[platform-admin-mfa] WARNING ${input.processLabel}: AUTH_MFA_ENFORCE_PLATFORM_ADMIN is off in production under the break-glass ` +
      `override ${PLATFORM_ADMIN_MFA_OVERRIDE_KEY} (owner decision 2 requires it on). Platform administrators can sign in without a ` +
      'second factor until the override is removed and the switch set back to true.',
  );
  // Not caught: an override that cannot be audited must not start the API (main.ts refuses the start on a throw).
  await input.sink.emit({
    type: PLATFORM_ADMIN_MFA_OVERRIDE_EVENT_TYPE,
    severity: 'critical',
    process: input.processLabel,
    detail: { variable: PLATFORM_ADMIN_MFA_OVERRIDE_KEY, reason },
  });
  return true;
}
