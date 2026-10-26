import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AI_PROVIDER_KEY_ENVS } from '../ai/models/provider-keys';
import { AuditService } from '../audit/audit.service';
import { AccessTokenService } from '../auth/token/services/access-token.service';
import { EmailService } from '../email/email.service';
import { EnvironmentVariables } from '../environment/environment-variables';
import { EnvironmentService } from '../environment/environment.service';
import { SecretEncryptionService } from '../secret-encryption/secret-encryption.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { assertActivePlatformAdmin, refuseInspection, withTimeout } from './admin-actor';
import { ADMIN_PANEL_AUDIT_ACTION, recordAdminPanelAudit } from './admin-panel-audit-actions';
import { PlatformAdminService } from './platform-admin.service';

type Actor = Pick<AuthContext, 'userId' | 'organisationId' | 'inspectedBy'>;

/**
 * How a variable may be shown (owner decision D8, 2026-10-24):
 *  - `value`: a non-secret, non-URL setting → its value (still only if it looks like a plain token, see SAFE_VALUE);
 *  - `secret` and `url`: only "Set" / "Not set" — never the value, a fragment of it, a host name or a credential.
 */
type EnvKind = 'value' | 'secret' | 'url';
interface EnvEntry {
  group: string;
  key: keyof EnvironmentVariables;
  kind: EnvKind;
}

/** THE allowlist. A variable not listed here is never read by this endpoint. */
export const ENVIRONMENT_ALLOWLIST: readonly EnvEntry[] = [
  { group: 'App', key: 'NODE_ENV', kind: 'value' },
  { group: 'App', key: 'APP_VERSION', kind: 'value' },
  { group: 'App', key: 'APP_GIT_COMMIT', kind: 'value' },
  { group: 'App', key: 'APP_URL', kind: 'url' },
  { group: 'App', key: 'ACCOUNTS_URL', kind: 'url' },
  { group: 'App', key: 'CORS_ORIGINS', kind: 'url' },
  { group: 'App', key: 'TRUSTED_PROXY_CIDRS', kind: 'url' },
  { group: 'App', key: 'WORKSPACE_BASE_DOMAIN', kind: 'url' },
  { group: 'Secrets', key: 'APP_SECRET', kind: 'secret' },
  { group: 'Secrets', key: 'APP_ENCRYPTION_KEYRING', kind: 'secret' },
  { group: 'Secrets', key: 'APP_ENCRYPTION_ACTIVE_KID', kind: 'value' },
  { group: 'Secrets', key: 'APP_JWT_SIGNING_KEYRING', kind: 'secret' },
  { group: 'Secrets', key: 'APP_JWT_ACTIVE_KID', kind: 'value' },
  { group: 'Secrets', key: 'APP_AUTH_CACHE_HMAC_KEY', kind: 'secret' },
  { group: 'Secrets', key: 'SENTRY_DSN', kind: 'secret' },
  { group: 'Database', key: 'DATABASE_URL', kind: 'secret' },
  { group: 'Redis', key: 'REDIS_URL', kind: 'secret' },
  { group: 'Redis', key: 'BULLMQ_PREFIX', kind: 'value' },
  { group: 'Worker', key: 'WORKER_SCHEDULER', kind: 'value' },
  { group: 'Worker', key: 'WORKER_SCHEDULER_RECONCILE_SECONDS', kind: 'value' },
  { group: 'Worker', key: 'OUTBOX_RETENTION_ENABLED', kind: 'value' },
  { group: 'Worker', key: 'OUTBOX_RETENTION_MODE', kind: 'value' },
  { group: 'Worker', key: 'LOGIN_HANDOFF_CLEANUP_ENABLED', kind: 'value' },
  { group: 'Storage', key: 'STORAGE_DRIVER', kind: 'value' },
  { group: 'Storage', key: 'S3_BUCKET', kind: 'value' },
  { group: 'Storage', key: 'S3_REGION', kind: 'value' },
  { group: 'Storage', key: 'S3_ENDPOINT', kind: 'url' },
  { group: 'Storage', key: 'S3_ACCESS_KEY_ID', kind: 'secret' },
  { group: 'Storage', key: 'S3_SECRET_ACCESS_KEY', kind: 'secret' },
  { group: 'Email', key: 'EMAIL_DRIVER', kind: 'value' },
  { group: 'Email', key: 'EMAIL_DELIVERY_ENABLED', kind: 'value' },
  { group: 'Email', key: 'EMAIL_FROM_ADDRESS', kind: 'value' },
  { group: 'Email', key: 'EMAIL_REPLY_TO', kind: 'value' },
  { group: 'Email', key: 'EMAIL_SMTP_HOST', kind: 'url' },
  { group: 'Email', key: 'EMAIL_SMTP_PORT', kind: 'value' },
  { group: 'Email', key: 'EMAIL_SMTP_USER', kind: 'secret' },
  { group: 'Email', key: 'EMAIL_SMTP_PASSWORD', kind: 'secret' },
  { group: 'Email', key: 'RESEND_API_KEY', kind: 'secret' },
  { group: 'Sign-in', key: 'AUTH_PASSWORD_ENABLED', kind: 'value' },
  { group: 'Sign-in', key: 'AUTH_GOOGLE_ENABLED', kind: 'value' },
  { group: 'Sign-in', key: 'AUTH_GOOGLE_CLIENT_SECRET', kind: 'secret' },
  { group: 'Sign-in', key: 'AUTH_MICROSOFT_ENABLED', kind: 'value' },
  { group: 'Sign-in', key: 'AUTH_MICROSOFT_CLIENT_SECRET', kind: 'secret' },
  { group: 'Sign-in', key: 'AUTH_STEP_UP_WINDOW_SECONDS', kind: 'value' },
  { group: 'Features', key: 'HWS_RUNTIME_ENABLED', kind: 'value' },
  { group: 'Features', key: 'REALTIME_ENABLED', kind: 'value' },
  { group: 'Features', key: 'PUSH_ENABLED', kind: 'value' },
  { group: 'Features', key: 'PUSH_PROVIDER', kind: 'value' },
  { group: 'Features', key: 'FIREBASE_SERVICE_ACCOUNT_JSON', kind: 'secret' },
  { group: 'Features', key: 'APNS_AUTH_KEY_P8', kind: 'secret' },
  // AI (Part A owner decision 2; Phase 1 "real models only" TP-8): every provider key is `secret` — "configured" only,
  // never a value, a prefix or a length. The model id lists are plain values (catalogue ids).
  { group: 'AI providers', key: 'AI_ENABLED', kind: 'value' },
  ...AI_PROVIDER_KEY_ENVS.map((key) => ({ group: 'AI providers', key, kind: 'secret' as const })),
  { group: 'AI providers', key: 'AI_DEV_ALLOW_REAL_PROVIDERS', kind: 'value' },
  { group: 'AI providers', key: 'AI_DAILY_BUDGET_USD', kind: 'value' },
  // 7b: the per-user ceiling and the owner's rate limits (plain numbers).
  { group: 'AI providers', key: 'AI_USER_DAILY_BUDGET_USD', kind: 'value' },
  { group: 'AI providers', key: 'AI_USER_RATE_PER_MIN', kind: 'value' },
  { group: 'AI providers', key: 'AI_ORG_RATE_PER_MIN', kind: 'value' },
  { group: 'AI providers', key: 'AI_USER_TURNS_PER_DAY', kind: 'value' },
  { group: 'AI providers', key: 'AI_MODELS_DEFAULT_FAST', kind: 'value' },
  { group: 'AI providers', key: 'AI_MODELS_DEFAULT_SMART', kind: 'value' },
  { group: 'AI providers', key: 'AI_MODELS_DEFAULT_DISABLED', kind: 'value' },
];

/** A shown value must look like a plain setting: no scheme, credentials, slashes or whitespace runs. */
const SAFE_VALUE = /^[A-Za-z0-9._:@+-]{1,120}$/;

export interface EnvironmentRow {
  group: string;
  key: string;
  /** `set` / `not_set` for secrets and URLs; the value for plain settings. */
  state: 'set' | 'not_set' | 'value';
  value: string | null;
  /** `env (secret)` for secret-classed keys; URL/host keys are `env` (hidden as "Set", but not secrets). */
  source: 'env' | 'env (secret)';
}

export function environmentRows(read: (key: keyof EnvironmentVariables) => unknown): EnvironmentRow[] {
  return ENVIRONMENT_ALLOWLIST.map(({ group, key, kind }) => {
    let raw: unknown;
    try {
      raw = read(key);
    } catch {
      raw = undefined;
    }
    const present = raw !== undefined && raw !== null && String(raw) !== '';
    const source = kind === 'secret' ? 'env (secret)' : 'env';
    if (kind !== 'value' || !present) return { group, key, state: present ? 'set' : 'not_set', value: null, source } as EnvironmentRow;
    const text = String(raw);
    // A "plain" setting that nevertheless looks like a URL/credential is reported as set, never echoed.
    if (!SAFE_VALUE.test(text) || /:\/\//.test(text)) return { group, key, state: 'set', value: null, source };
    return { group, key, state: 'value', value: text, source };
  });
}

export interface SecuritySwitch {
  label: string;
  variable: string;
  state: string;
  recommended: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
}

export interface SigningKeyRow {
  kid: string;
  use: 'signs_and_verifies' | 'verifies_only';
  derivedFrom: string;
  status: 'active' | 'accepted';
  /** No per-kid verification counter exists yet — always null ("not measured"), never a guess. */
  verified24h: null;
}

/**
 * Crewflow Platform Admin Panel — Config (email, environment) and Security (switches, signing keys) tabs, plus the
 * "Send test email to me" action. Read-only except the test email.
 *
 * D5 (owner): email delivery is configured by environment variables only (EMAIL_DRIVER, EMAIL_FROM_ADDRESS, …). The old
 * editable database SMTP form is retired in the UI because no driver reads it. The test email goes through the LIVE
 * configured driver to the admin's OWN account address only (no recipient field exists), is throttled at the route, and
 * audited (`admin.test_email_sent`).
 */
@Injectable()
export class AdminConfigService {
  private readonly logger = new Logger(AdminConfigService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly audit: AuditService,
    private readonly emailService: EmailService,
    private readonly accessTokens: AccessTokenService,
    private readonly secretEncryption: SecretEncryptionService,
  ) {}

  general(): { version: string; commit: string | null } {
    const commit = this.env.get('APP_GIT_COMMIT');
    return { version: this.env.get('APP_VERSION') || 'dev', commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 12) : null };
  }

  async environment(actor: Actor): Promise<EnvironmentRow[]> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    return environmentRows((key) => this.env.get(key));
  }

  async email(actor: Actor): Promise<{ driver: string; fromAddress: string | null; replyToSet: boolean; deliveryEnabled: boolean; credential: 'set' | 'not_set' | 'not_needed' }> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const driver = this.env.get('EMAIL_DRIVER');
    const from = this.env.get('EMAIL_FROM_ADDRESS');
    const credential = driver === 'RESEND' ? (this.env.get('RESEND_API_KEY') ? 'set' : 'not_set') : driver === 'SMTP' ? (this.env.get('EMAIL_SMTP_PASSWORD') ? 'set' : 'not_set') : 'not_needed';
    return {
      driver: ['LOGGER', 'SMTP', 'RESEND'].includes(driver) ? driver : 'UNKNOWN',
      fromAddress: from && SAFE_VALUE.test(from) ? from : null,
      replyToSet: Boolean(this.env.get('EMAIL_REPLY_TO')),
      deliveryEnabled: this.env.get('EMAIL_DELIVERY_ENABLED') === true,
      credential,
    };
  }

  async sendTestEmail(actor: Actor): Promise<{ sent: boolean; to: string; driver: string }> {
    refuseInspection(actor);
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const driver = this.env.get('EMAIL_DRIVER');
    const to = await this.tenantContext.runInTenantContext({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, async (manager) => {
      const [row] = await manager.query<Array<{ email: string }>>('SELECT email::text AS email FROM core."user" WHERE id = $1 AND deleted_at IS NULL', [actor.userId]);
      return row?.email ?? null;
    });
    if (!to) return { sent: false, to: '', driver };
    let sent = false;
    try {
      await withTimeout(
        this.emailService.send({
          to,
          // One logical delivery per click (provider idempotency key / deterministic Message-ID).
          idempotencyKey: `admin-test-email.${actor.userId}.${randomUUID()}`,
          subject: 'Crewflow — test email from the Admin panel',
          text: 'This is a test email sent from the Crewflow Admin panel using the server’s current email settings. No action is needed.',
          html: '<p>This is a test email sent from the Crewflow Admin panel using the server’s current email settings.</p><p>No action is needed.</p>',
        }),
        10_000,
      );
      sent = true;
    } catch (error) {
      this.logger.warn(`admin test email failed (driver ${driver}): ${(error as Error).name}`);
    }
    await this.tenantContext.runInTenantContext({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, (manager) =>
      recordAdminPanelAudit(this.audit, manager, actor, ADMIN_PANEL_AUDIT_ACTION.TEST_EMAIL_SENT, { targetUserId: actor.userId, metadata: { kind: driver.toLowerCase(), enabled: sent } }),
    );
    return { sent, to: maskEmail(to), driver };
  }

  async security(actor: Actor): Promise<{ switches: SecuritySwitch[]; signingKeys: SigningKeyRow[]; encryptionKeys: { activeKid: string; kids: string[] } }> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const on = (k: keyof EnvironmentVariables) => this.env.get(k) === true;
    const anyEnforced = (['AUTH_MFA_ENFORCE_PLATFORM_ADMIN', 'AUTH_MFA_ENFORCE_ORGANISATION_OWNER', 'AUTH_MFA_ENFORCE_INITIAL_MANAGER', 'AUTH_MFA_ENFORCE_OTHER_WEB_USERS'] as const).filter((k) => on(k));
    const sw = (label: string, variable: string, state: string, recommended: string, tone: SecuritySwitch['tone']): SecuritySwitch => ({ label, variable, state, recommended, tone });
    const switches: SecuritySwitch[] = [
      sw('Users may turn on 2FA', 'AUTH_MFA_ENROLMENT_ENABLED', on('AUTH_MFA_ENROLMENT_ENABLED') ? 'On' : 'Off', 'On', on('AUTH_MFA_ENROLMENT_ENABLED') ? 'ok' : 'warn'),
      sw('Force 2FA for any role (4 settings)', 'AUTH_MFA_ENFORCE_*', anyEnforced.length ? `On (${anyEnforced.length})` : 'Off', 'Off: 2FA is optional (owner policy)', anyEnforced.length ? 'warn' : 'neutral'),
      sw('Ask for the code on mobile once turned on', 'AUTH_MFA_MOBILE_POLICY', String(this.env.get('AUTH_MFA_MOBILE_POLICY')), 'require (after mobile 2FA screens ship)', this.env.get('AUTH_MFA_MOBILE_POLICY') === 'require' ? 'ok' : 'neutral'),
      sw('Code also required for older confirmed actions', 'AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS', on('AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS') ? 'On' : 'Off', 'On', on('AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS') ? 'ok' : 'warn'),
      sw('Host routing for workspace addresses', 'WORKSPACE_HOST_ROUTING_ENABLED', on('WORKSPACE_HOST_ROUTING_ENABLED') ? 'On' : 'Off', 'When DNS is ready', 'neutral'),
      sw('__Host- cookie names', 'AUTH_COOKIE_HOST_PREFIX_ENABLED', on('AUTH_COOKIE_HOST_PREFIX_ENABLED') ? 'On' : 'Off', 'On', on('AUTH_COOKIE_HOST_PREFIX_ENABLED') ? 'ok' : 'warn'),
      sw('Refuse reused secrets across key roles', 'APP_KEY_SEPARATION_REQUIRED', on('APP_KEY_SEPARATION_REQUIRED') ? 'On' : 'Off', 'On', on('APP_KEY_SEPARATION_REQUIRED') ? 'ok' : 'warn'),
      sw('Accept tokens signed with legacy APP_SECRET', 'APP_JWT_LEGACY_VERIFY_ENABLED', on('APP_JWT_LEGACY_VERIFY_ENABLED') ? 'On' : 'Off', 'Off', on('APP_JWT_LEGACY_VERIFY_ENABLED') ? 'bad' : 'ok'),
      sw('Workspace subdomain origin trust', 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', on('WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED') ? 'On' : 'Off', 'Off until host routing', on('WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED') && !on('WORKSPACE_HOST_ROUTING_ENABLED') ? 'bad' : 'ok'),
      sw('Cross-host sign-in handoff', 'AUTH_LOGIN_HANDOFF_ENABLED', on('AUTH_LOGIN_HANDOFF_ENABLED') ? 'On' : 'Off', 'With host routing', 'neutral'),
      sw('Workspace schemas hold business data', 'HWS_RUNTIME_ENABLED', on('HWS_RUNTIME_ENABLED') ? 'On' : 'Off', 'After the production rehearsal', 'neutral'),
    ];
    const keyring = this.accessTokens.getKeyringSummary();
    const signingKeys: SigningKeyRow[] = keyring.kids.map((kid) => ({
      kid: /^[A-Za-z0-9._-]{1,64}$/.test(kid) ? kid : 'unnamed',
      use: kid === keyring.activeKid ? 'signs_and_verifies' : 'verifies_only',
      derivedFrom: kid === 'legacy' ? 'Raw APP_SECRET (legacy)' : kid.startsWith('derived-') ? 'HKDF purpose key from APP_SECRET' : 'APP_JWT_SIGNING_KEYRING',
      status: kid === keyring.activeKid ? 'active' : 'accepted',
      verified24h: null,
    }));
    const enc = this.secretEncryption.getKeyringSummary();
    return { switches, signingKeys, encryptionKeys: { activeKid: enc.activeKid, kids: [...enc.kids] } };
  }
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '';
  return `${local.slice(0, 2)}…@${domain}`;
}
