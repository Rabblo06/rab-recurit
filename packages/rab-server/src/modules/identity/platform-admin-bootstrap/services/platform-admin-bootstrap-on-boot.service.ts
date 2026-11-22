import { HttpException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { EnvironmentService } from '../../../../engine/core-modules/environment/environment.service';
import {
  PlatformAdminBootstrapError,
  PlatformAdminBootstrapResult,
  PlatformAdminBootstrapService,
  readPlatformAdminBootstrapInput,
} from './platform-admin-bootstrap.service';

/** What one boot did (returned for tests; the operator sees the log lines in PLATFORM_ADMIN_BOOT_LOG). */
export type PlatformAdminBootOutcome =
  | 'NOT_CONFIGURED'
  | 'REFUSED_PASSWORD_SET'
  | 'REFUSED_MFA_NOT_ENFORCED'
  | 'ALREADY_ATTEMPTED'
  | PlatformAdminBootstrapResult['outcome']
  | 'FAILED';

/**
 * Every line this provider logs, fixed text (no email address, no user id, no database message): the PR description and
 * THREAT-MODEL.md quote them, and the unit spec asserts them verbatim.
 */
export const PLATFORM_ADMIN_BOOT_LOG = {
  passwordRefused:
    'BOOTSTRAP_ADMIN_PASSWORD is set: refused. The first platform administrator is created without a password and activates through an emailed, expiring link. Remove BOOTSTRAP_ADMIN_PASSWORD; nothing was done.',
  created: (expiresAt: Date) =>
    `First platform administrator created from BOOTSTRAP_ADMIN_EMAIL, pending activation. One activation email is queued to that address only; the link expires at ${expiresAt.toISOString()}. Remove BOOTSTRAP_ADMIN_EMAIL from rab-api once the administrator has signed in.`,
  mfaNotEnforced:
    'BOOTSTRAP_ADMIN_EMAIL is set but AUTH_MFA_ENFORCE_PLATFORM_ADMIN is not true: refusing to create a platform admin without enforced MFA. Set AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true and redeploy. Nothing was done and no email was sent.',
  grantedExisting:
    'First platform administrator granted to the existing active, email-verified manager account matching BOOTSTRAP_ADMIN_EMAIL. No activation email was sent (that account already signs in with its own password); its existing sessions were ended. Remove BOOTSTRAP_ADMIN_EMAIL from rab-api.',
  existingUnverified:
    'BOOTSTRAP_ADMIN_EMAIL matches an existing account that is not active with a verified email (for example a pending invitation): refused, nothing was done and no email was sent. Use the grant-platform-admin command for an existing account.',
  existingNotManager:
    'BOOTSTRAP_ADMIN_EMAIL matches an existing account that has no manager profile (for example a staff-only account): refused, nothing was done and no email was sent. Use a different email, or the grant-platform-admin command for an existing account.',
  alreadyExists: 'A platform administrator already exists: nothing was done and no email was sent. BOOTSTRAP_ADMIN_EMAIL can be removed from rab-api.',
  activationExpired:
    'A platform administrator already exists but never activated, and its activation link has expired: nothing was done and no email was sent. No command re-sends that link today; see THREAT-MODEL.md (first platform administrator at API boot, residual) for the recovery. BOOTSTRAP_ADMIN_EMAIL does not help and can be removed from rab-api.',
  closed:
    'Platform administrators have existed on this database and none is active: the one-time bootstrap is closed, nothing was done and no email was sent. BOOTSTRAP_ADMIN_EMAIL can be removed from rab-api; restoring an administrator is a deliberate grant-platform-admin action.',
  ambiguousEmail:
    'BOOTSTRAP_ADMIN_EMAIL matches existing accounts in more than one organisation: refused, nothing was done and no email was sent. Run the grant-platform-admin command with --email and --org instead.',
  ambiguousOrganisation:
    'Several organisations exist and none has an account matching BOOTSTRAP_ADMIN_EMAIL: refused, nothing was done and no email was sent. Set BOOTSTRAP_ADMIN_ORG_SLUG on rab-api, or run the grant-platform-admin command.',
  failed: (reason: PlatformAdminBootFailureReason) =>
    `The first platform administrator was not created at boot (reason: ${reason}). The attempt was rolled back: no administrator was created and no email was queued. The API keeps starting and does not retry until its next restart.`,
} as const;

export type PlatformAdminBootFailureReason =
  | 'function-missing'
  | 'not-authorised'
  | 'invalid-input'
  | 'organisation-suspended'
  | 'unexpected-result'
  | `database-error-${string}`
  | 'unexpected-error';

/** A fixed reason label for a failure: never the error message (it can carry the email, a role name or SQL). */
export function platformAdminBootFailureReason(error: unknown): PlatformAdminBootFailureReason {
  if (error instanceof PlatformAdminBootstrapError) {
    if (error.reason === 'FUNCTION_MISSING') return 'function-missing';
    if (error.reason === 'NOT_AUTHORISED') return 'not-authorised';
    return 'unexpected-result';
  }
  // AccountLifecycleService.sendAccountInvite refuses a suspended organisation with a 403.
  if (error instanceof HttpException && error.getStatus() === 403) return 'organisation-suspended';
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : typeof candidate?.driverError?.code === 'string' ? candidate.driverError.code : null;
  if (code === '22023') return 'invalid-input'; // the function's own validation of the email / names / slug
  if (code !== null && /^[0-9A-Z]{5}$/.test(code)) return `database-error-${code}`; // SQLSTATE only
  return 'unexpected-error';
}

/**
 * First platform administrator at API boot (owner request 2026-11-19): when `BOOTSTRAP_ADMIN_EMAIL` is set on rab-api, the
 * API runs the SAME bootstrap as the `bootstrap-admin` command (`PlatformAdminBootstrapService`) once, during Nest's
 * `onApplicationBootstrap` — after main.ts's runtime-identity check, database boot gates and posture monitor, before the
 * HTTP listener opens. This class is a transport adapter only: every decision (one-time, who, which organisation, the
 * invite, the audit entry) is made by the shared service and the database function.
 *
 *   - Not set: does nothing, logs nothing.
 *   - `BOOTSTRAP_ADMIN_PASSWORD` set: refused and nothing is done (the API's in-process runtime guard and api-prestart.sh
 *     already refuse to start with it; this is the service-level copy of that rule).
 *   - AUTH_MFA_ENFORCE_PLATFORM_ADMIN not true: refused before anything runs (security review of #264, F1), so the admin this
 *     path creates is always made to enrol MFA at first sign-in.
 *   - An existing account matching the email is granted only when it is ACTIVE, email-verified and manager-tier (F2/F3);
 *     otherwise refused and rolled back. The CLI keeps its own rule.
 *   - An existing admin that never activated and whose link expired gets a distinct line (F5); nothing is re-sent.
 *   - An administrator already exists (or the bootstrap is CLOSED): nothing is written, no email is queued, and ONE line
 *     says the variable can be removed. So a restart never sends a second email.
 *   - Two replicas booting together: the database function's transaction-scoped advisory lock serialises them; the loser
 *     answers ALREADY_BOOTSTRAPPED (see PlatformAdminBootstrapService).
 *   - Fail closed WITHOUT a crash loop (stated choice): any failure is logged with a fixed message and a fixed reason label,
 *     the transaction rolls back (so no email row exists), and the boot continues. Exactly one attempt per process start —
 *     no in-process retry, so a persistent failure cannot spam email; the next attempt is the next restart, and a failed
 *     attempt never queues an email, so restarts cannot either.
 *
 * Registered only in PlatformAdminBootstrapModule, which only AppModule (the API) imports: the CLI's CommandModule and the
 * Worker's WorkerModule never load it.
 */
@Injectable()
export class PlatformAdminBootstrapOnBoot implements OnApplicationBootstrap {
  private readonly logger = new Logger('PlatformAdminBootstrap');
  private attempted = false;

  constructor(
    private readonly bootstrap: PlatformAdminBootstrapService,
    private readonly env: EnvironmentService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.runOnce(process.env);
  }

  /** One attempt per process. Never throws. */
  async runOnce(env: Record<string, string | undefined>): Promise<PlatformAdminBootOutcome> {
    if (this.attempted) return 'ALREADY_ATTEMPTED';
    this.attempted = true;

    const input = readPlatformAdminBootstrapInput(env);
    if (!input) return 'NOT_CONFIGURED';
    if (env.BOOTSTRAP_ADMIN_PASSWORD?.trim()) {
      this.logger.error(PLATFORM_ADMIN_BOOT_LOG.passwordRefused);
      return 'REFUSED_PASSWORD_SET';
    }
    // Security review of #264, F1: the boot path only ever creates a platform admin that MUST enrol MFA at first sign-in.
    // LoginSecondFactorPolicyService answers 'enroll' for a platform admin without a factor only when this switch is true
    // (default false), so with it off the boot refuses before anything runs: no transaction, no write, no email.
    if (this.env.get('AUTH_MFA_ENFORCE_PLATFORM_ADMIN') !== true) {
      this.logger.error(PLATFORM_ADMIN_BOOT_LOG.mfaNotEnforced);
      return 'REFUSED_MFA_NOT_ENFORCED';
    }

    let result: PlatformAdminBootstrapResult;
    try {
      result = await this.bootstrap.run(input, {
        trigger: 'api_boot',
        selfHealExistingAdmin: false,
        requireProvenExistingAccount: true,
        inspectExistingAdminActivation: true,
      });
    } catch (error) {
      this.logger.error(PLATFORM_ADMIN_BOOT_LOG.failed(platformAdminBootFailureReason(error)));
      return 'FAILED';
    }

    switch (result.outcome) {
      case 'CREATED_INVITED':
        this.logger.log(PLATFORM_ADMIN_BOOT_LOG.created(result.activationExpiresAt));
        break;
      case 'GRANTED_EXISTING':
        this.logger.log(PLATFORM_ADMIN_BOOT_LOG.grantedExisting);
        break;
      case 'ALREADY_BOOTSTRAPPED':
        if (result.activation === 'expired') this.logger.warn(PLATFORM_ADMIN_BOOT_LOG.activationExpired);
        else this.logger.log(PLATFORM_ADMIN_BOOT_LOG.alreadyExists);
        break;
      case 'REFUSED_EXISTING_ACCOUNT_UNVERIFIED':
        this.logger.error(PLATFORM_ADMIN_BOOT_LOG.existingUnverified);
        break;
      case 'REFUSED_EXISTING_ACCOUNT_NOT_MANAGER':
        this.logger.error(PLATFORM_ADMIN_BOOT_LOG.existingNotManager);
        break;
      case 'CLOSED':
        this.logger.warn(PLATFORM_ADMIN_BOOT_LOG.closed);
        break;
      case 'REFUSED_AMBIGUOUS_EMAIL':
        this.logger.error(PLATFORM_ADMIN_BOOT_LOG.ambiguousEmail);
        break;
      case 'REFUSED_AMBIGUOUS_ORGANISATION':
        this.logger.error(PLATFORM_ADMIN_BOOT_LOG.ambiguousOrganisation);
        break;
    }
    return result.outcome;
  }
}
