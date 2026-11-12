import { randomUUID } from 'node:crypto';

import { AuditAction } from '../audit/audit.service';
import { createSecurityAuditSink, formatSecurityAuditEvent } from '../audit-sink/security-audit-sink';
import { AuditLogShippingRow, buildAuditRowSecurityEvent, buildLoginFailedSecurityEvent, maskEmailForAudit } from './build-security-audit-event';
import { SECURITY_AUDIT_CATEGORIES, SHIPPED_AUDIT_ACTIONS } from './security-audit-event-catalogue';

/**
 * X1.1: each event type reaches the sink REDACTED — no password, token or MFA secret, e-mails masked — and nothing that is
 * not in the security catalogue is shipped.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const ROW_ID = '44444444-4444-4444-8444-444444444444';

/** Fixture "secrets", generated per run (never literals: they must look nothing like a committed credential). */
const fake = (label: string) => `${label}-${randomUUID()}`;
const SECRETS = {
  password: fake('pw'),
  newPassword: fake('pw2'),
  token: fake('tk'),
  refreshToken: fake('rt'),
  tokenHash: fake('th'),
  totpSecret: fake('ts'),
  mfaSecret: fake('ms'),
  recoveryCodes: [fake('rc1'), fake('rc2')],
  otp: fake('otp'),
  apiKey: fake('ak'),
  authorization: fake('auth'),
};

const row = (action: string, metadata: Record<string, unknown>): AuditLogShippingRow => ({
  id: ROW_ID,
  organisation_id: ORG,
  actor_user_id: ACTOR,
  target_user_id: TARGET,
  action,
  entity_type: 'user',
  entity_id: TARGET,
  metadata,
  created_at: new Date('2026-11-12T10:00:00.000Z'),
});

/** What the stdout sink writes for `event`, captured. */
async function written(event: Parameters<typeof formatSecurityAuditEvent>[0]): Promise<string> {
  const lines: string[] = [];
  const sink = createSecurityAuditSink({ mode: 'stdout', file: null, failure: 'refuse', production: true }, { stdout: async (l) => void lines.push(l) });
  await sink.emit(event);
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function assertRedacted(line: string): void {
  for (const value of Object.values(SECRETS).flat()) expect(line).not.toContain(value);
  expect(line).not.toContain('alice.smith@example.com');
  expect(line).not.toContain('bob@corp.example');
  expect(line).not.toMatch(/postgres:\/\//);
}

describe('security audit event builder + sink redaction (X1.1)', () => {
  // One representative action per owner category, each carrying every kind of secret a careless caller might pass.
  const perCategory = new Map<string, string>();
  for (const [action, { category }] of Object.entries(SHIPPED_AUDIT_ACTIONS)) if (!perCategory.has(category) && action !== 'auth.login_failed') perCategory.set(category, action);

  it('has a representative for every category', () => {
    expect([...perCategory.keys()].sort()).toEqual([...SECURITY_AUDIT_CATEGORIES].sort());
  });

  it.each([...perCategory.entries()])('%s (%s): reaches the sink with ids, category and severity, redacted', async (category, action) => {
    const metadata = {
      ...SECRETS,
      email: 'alice.smith@example.com',
      note: 'contact bob@corp.example for details',
      dsn: 'postgres://crewflow_owner:pw@db:5432/rab',
      reason: 'routine',
      nested: { password: SECRETS.password, deeper: { token: SECRETS.token } },
    };
    const event = buildAuditRowSecurityEvent(row(action, metadata), 'worker');
    expect(event).not.toBeNull();
    const line = await written(event!);
    expect(line.startsWith('CREWFLOW_SECURITY_AUDIT ')).toBe(true);
    const parsed = JSON.parse(line.slice('CREWFLOW_SECURITY_AUDIT '.length));
    expect(parsed).toMatchObject({
      v: 1,
      type: action,
      severity: SHIPPED_AUDIT_ACTIONS[action]!.severity,
      process: 'worker',
      organisationId: ORG,
      actorUserId: ACTOR,
      detail: { category, source: 'audit_log', auditLogId: ROW_ID, targetUserId: TARGET, recordedAt: '2026-11-12T10:00:00.000Z' },
    });
    expect(parsed.detail.metadata.password).toBe('[REDACTED]');
    expect(parsed.detail.metadata.totpSecret).toBe('[REDACTED]');
    expect(parsed.detail.metadata.reason).toBe('routine');
    expect(parsed.detail.metadata.email).toBe('a***@example.com');
    assertRedacted(line);
  });

  it('an action outside the catalogue builds no event (never shipped)', () => {
    expect(buildAuditRowSecurityEvent(row(AuditAction.OFFER_SENT, {}), 'worker')).toBeNull();
    expect(buildAuditRowSecurityEvent(row(AuditAction.AI_TOOL_CALLED, {}), 'worker')).toBeNull();
  });

  it('login failure (pre-auth): masked e-mail, no organisation or user, uniform for every wrong credential', async () => {
    const event = buildLoginFailedSecurityEvent({ email: 'Alice.Smith@Example.com ', reason: 'invalid_credentials', provider: 'password' }, 'api');
    const line = await written(event);
    const parsed = JSON.parse(line.slice('CREWFLOW_SECURITY_AUDIT '.length));
    expect(parsed).toMatchObject({ type: 'auth.login_failed', severity: 'warning', process: 'api', organisationId: null, actorUserId: null });
    expect(parsed.detail).toEqual({ category: 'login', source: 'login_history', reason: 'invalid_credentials', provider: 'password', email: 'a***@example.com' });
    assertRedacted(line);
  });

  it('login failure: a password typed into the e-mail field is never shipped', async () => {
    const line = await written(buildLoginFailedSecurityEvent({ email: SECRETS.password, reason: 'invalid_credentials', provider: 'password' }, 'api'));
    expect(line).not.toContain(SECRETS.password);
    expect(JSON.parse(line.slice('CREWFLOW_SECURITY_AUDIT '.length)).detail.email).toBe('[not-an-email]');
  });

  it('maskEmailForAudit', () => {
    expect(maskEmailForAudit('bob@corp.example')).toBe('b***@corp.example');
    expect(maskEmailForAudit('  ')).toBe('[none]');
    expect(maskEmailForAudit(null)).toBe('[none]');
    expect(maskEmailForAudit('no-at-sign')).toBe('[not-an-email]');
    expect(maskEmailForAudit('two@@example.com')).toBe('[not-an-email]');
  });
});
