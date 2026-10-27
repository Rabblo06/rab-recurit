import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import {
  ADMIN_AUDIT_ACTIONS_1786720100000,
  ADMIN_AUDIT_VIA_ACTIONS_1786720100000,
  ADMIN_USER_ROLE_FILTERS_1786720100000,
} from '../../../database/typeorm/core/migrations/1786720100000-AdminPanelReadFunctions';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { MANAGER_APPLICATION } from '../auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { decodeCursor, encodeCursor, optionalReason, requireReason } from './admin-actor';
import { AdminAuditController } from './admin-audit.controller';
import { ENVIRONMENT_ALLOWLIST, environmentRows, maskEmail } from './admin-config.service';
import { ADMIN_TIMELINE_ACTIONS } from './admin-panel-audit-actions';
import { AdminPanelController } from './admin-panel.controller';
import { safeErrorLabel, toAuditItem, toUserListItem, toWorkspaceListItem } from './admin-panel.mappers';
import { AdminQueuesController } from './admin-queues.controller';
import { classifyFailure, parseCycles, toJobItem } from './admin-queues.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminWorkspacesController } from './admin-workspaces.controller';
import { ADMIN_USER_ROLE_FILTERS } from './dto/admin-panel.dto';

const FORBIDDEN_KEY = /password|hash|secret|token|rendered|pence|amount|stack|failedreason|metadata|^data$|^payload$|^body$/i;
const keysDeep = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(keysDeep) : v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => [k, ...keysDeep(x)]) : [];

describe('Admin Panel — unit', () => {
  it('the service audit allowlist is identical to the SQL function allowlist (frozen in the migration)', () => {
    expect([...ADMIN_TIMELINE_ACTIONS].sort()).toEqual([...ADMIN_AUDIT_ACTIONS_1786720100000, ...ADMIN_AUDIT_VIA_ACTIONS_1786720100000].sort());
    expect([...ADMIN_USER_ROLE_FILTERS].sort()).toEqual([...ADMIN_USER_ROLE_FILTERS_1786720100000].sort());
  });

  it.each([AdminUsersController, AdminQueuesController, AdminWorkspacesController, AdminAuditController, AdminPanelController])(
    '%p: JwtAuthGuard + PlatformAdminGuard + @ManagerApplication() + a class-level throttle',
    (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([JwtAuthGuard, PlatformAdminGuard]);
      expect(Reflect.getMetadata(MANAGER_APPLICATION, controller)).toBe(true);
      expect(Reflect.getMetadataKeys(controller).some((k: unknown) => String(k).startsWith('THROTTLER:LIMIT'))).toBe(true);
    },
  );

  it('reason: trimmed, 3–500 characters, otherwise 400; optional reason validated only when present', () => {
    expect(requireReason('  ok reason  ')).toBe('ok reason');
    for (const bad of [undefined, '', 'ab', '   ab ', 'x'.repeat(501), 42]) expect(() => requireReason(bad)).toThrow();
    expect(optionalReason(undefined)).toBeUndefined();
    expect(optionalReason('  ')).toBeUndefined();
    expect(() => optionalReason('ab')).toThrow();
  });

  it('cursor: round-trips; any tampering is a 400 (never a guess)', () => {
    const id = '1b2c3d4e-0000-4000-8000-000000000000';
    const cursor = encodeCursor(new Date('2026-10-24T09:31:00.000Z'), id);
    expect(decodeCursor(cursor)).toEqual({ at: new Date('2026-10-24T09:31:00.000Z'), id });
    expect(decodeCursor(undefined)).toBeNull();
    for (const bad of ['!!', Buffer.from('2026-10-24|x').toString('base64url'), Buffer.from(`not-a-date|${id}`).toString('base64url'), Buffer.from(`2026-10-24T09:31:00.000Z|${id}|extra`).toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow();
    }
  });

  it('environment rows: a secret, URL or host never echoes its value, even when planted; plain values pass only when token-shaped', () => {
    const planted: Record<string, unknown> = {
      APP_SECRET: 'planted-secret',
      DATABASE_URL: 'postgres://u:planted-pw@planted-host/db',
      REDIS_URL: 'redis://:planted@host:6379',
      APP_URL: 'https://planted-app.example',
      WORKSPACE_BASE_DOMAIN: 'planted-domain.example',
      EMAIL_FROM_ADDRESS: 'https://planted-url',
      NODE_ENV: 'production',
      BULLMQ_PREFIX: 'crewflow:production:bull',
      S3_BUCKET: 'bucket with spaces and / slashes',
    };
    const rows = environmentRows((k) => planted[k]);
    const raw = JSON.stringify(rows);
    for (const p of ['planted-secret', 'planted-pw', 'planted-host', 'planted-app', 'planted-domain', 'planted-url', 'slashes']) expect(raw).not.toContain(p);
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row('NODE_ENV')).toEqual({ group: 'App', key: 'NODE_ENV', state: 'value', value: 'production', source: 'env' });
    expect(row('BULLMQ_PREFIX').value).toBe('crewflow:production:bull');
    expect(row('APP_SECRET')).toMatchObject({ state: 'set', value: null, source: 'env (secret)' });
    expect(row('S3_BUCKET')).toMatchObject({ state: 'set', value: null });
    expect(row('RESEND_API_KEY')).toMatchObject({ state: 'not_set', value: null });
    // Every secret-looking key is classed secret/url, never value.
    for (const e of ENVIRONMENT_ALLOWLIST) if (/SECRET|PASSWORD|KEY$|KEYRING|_URL$|DSN|JSON|P8|ENDPOINT|HOST$|ACCESS_KEY/.test(e.key) && !/KID$|_ENABLED$/.test(e.key)) expect({ k: e.key, kind: e.kind }).not.toEqual({ k: e.key, kind: 'value' });
  });

  it('maskEmail never returns the full address', () => {
    expect(maskEmail('issac.admin@example.test')).toBe('is…@example.test');
    expect(maskEmail('nope')).toBe('');
  });

  it('failure classes are fixed labels — free text with secrets is never passed through', () => {
    expect(classifyFailure('UnrecoverableError: invalid recipient')).toBe('UNRECOVERABLE');
    expect(classifyFailure('Resend 429 Too Many Requests')).toBe('PROVIDER_429');
    expect(classifyFailure('job stalled more than allowable limit')).toBe('STALLED');
    expect(classifyFailure('connect ECONNREFUSED 10.0.0.4:587')).toBe('NETWORK');
    expect(classifyFailure('EMPTY_BODY')).toBe('EMPTY_BODY');
    expect(classifyFailure('provider said alice@example.test rejected token=abc')).toBe('SEE_WORKER_LOG');
    expect(classifyFailure(undefined)).toBeNull();
  });

  it('job items never carry data, return values or the failure message', () => {
    const job = {
      id: '42',
      name: 'send',
      timestamp: 1_792_870_000_000,
      processedOn: 1_792_870_001_000,
      finishedOn: 1_792_870_002_000,
      attemptsMade: 5,
      opts: { attempts: 5 },
      failedReason: 'secret detail token=abc',
      stacktrace: ['at secret'],
      returnvalue: { secret: 1 },
      data: { emailOutboxId: '1b2c3d4e-0000-4000-8000-000000000000', organisationId: '2b2c3d4e-0000-4000-8000-000000000000', html: '<p>body</p>', token: 'abc' },
    };
    const item = toJobItem(job as never, 'failed', { idKeys: ['emailOutboxId', 'organisationId'] });
    expect(item).toMatchObject({ id: '42', errorClass: 'SEE_WORKER_LOG', entityId: job.data.emailOutboxId, organisationId: job.data.organisationId, attemptsMade: 5, maxAttempts: 5 });
    expect(JSON.stringify(item)).not.toMatch(/secret|token|body|<p>/);
    expect(toJobItem(job as never, 'failed', { idKeys: [] })).toMatchObject({ entityId: null, organisationId: null });
  });

  it('cycle durations: numbers only; the host:pid instance field and malformed loops are dropped', () => {
    const cycles = parseCycles('worker', {
      'offer-expiry': JSON.stringify({ n: 3, p50: 9, p95: 85, p99: 85, max: 85, lastMs: 8, succeeded: 3, idle: 0, failed: 0, skipped: 0, at: 1_792_875_185_506, instance: 'host-a:14' }),
      'Bad Key!': '{}',
      broken: 'not json',
    });
    expect(cycles).toEqual([
      { source: 'worker', loop: 'offer-expiry', runs: 3, p50Ms: 9, p95Ms: 85, maxMs: 85, lastMs: 8, succeeded: 3, idle: 0, failed: 0, skipped: 0, measuredAt: new Date(1_792_875_185_506).toISOString() },
    ]);
    expect(JSON.stringify(cycles)).not.toContain('host-a');
  });

  it('mappers are explicit allowlists: unknown columns never pass, no forbidden key exists, error labels are safe', () => {
    const user = toUserListItem({
      userId: 'u1', organisationId: 'o1', organisationName: 'Org', firstName: 'Sam', lastName: 'Patel', email: 'sam@example.test', status: 'active',
      createdAt: '2026-10-01T00:00:00Z', lastLoginAt: null, totpEnabled: true, mfaEnabledAt: '2026-10-02T00:00:00Z', recoveryCodesRemaining: 8, recoveryCodesTotal: 10,
      isPlatformAdmin: false, roleKeys: ['venue_manager', 'custom-role'], roleNames: ['Venue Manager'], matchKind: 'email',
      ...({ passwordHash: 'x', totpSecretEncrypted: 'y' } as object),
    } as never);
    expect(user.twoFactor).toEqual({ enabled: true, enabledAt: '2026-10-02T00:00:00.000Z', recoveryCodesRemaining: 8, recoveryCodesTotal: 10 });
    expect(user.roleKeys).toEqual(['venue_manager']);
    expect(keysDeep(user).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
    expect(safeErrorLabel('PROVISION_FAILED · 42P07')).toBe('UNCLASSIFIED');
    expect(safeErrorLabel('PROVISION_FAILED 42P07')).toBe('PROVISION_FAILED 42P07');
    expect(safeErrorLabel('relation "workspace_x.shift" already exists')).toBe('UNCLASSIFIED');
    expect(safeErrorLabel('module v1.001-template refused (BASELINE_MISMATCH)')).toBe('module v1.001-template refused (BASELINE_MISMATCH)');
    const ws = toWorkspaceListItem({ workspaceId: 'w', organisationId: 'o', organisationName: null, workspaceName: 'Main', schemaName: 'workspace_x; DROP', schemaStatus: 'EVIL', schemaVersion: 1, schemaError: null, schemaMigratedAt: null, updatedAt: '2026-10-01T00:00:00Z', registryStatus: 'READY', moduleVersion: 17, driftStatus: 'OK', registryError: null });
    expect(ws).toMatchObject({ schemaName: null, schemaStatus: null, registryStatus: 'READY' });
    expect(toAuditItem({ action: 'user.created' } as never, ADMIN_TIMELINE_ACTIONS)).toBeNull();
    const audit = toAuditItem(
      { id: 'a', organisationId: 'o', organisationName: 'Org', action: 'admin.queue_jobs_retried', actorUserId: 'u', actorFirstName: 'I', actorLastName: 'A', targetUserId: null, targetFirstName: null, targetLastName: null, entityType: null, entityId: null, createdAt: '2026-10-24T09:31:00Z', reason: 'r', detail: { queue: 'rab-email', count: 3, jobIds: ['x'], secret: 'y' } } as never,
      ADMIN_TIMELINE_ACTIONS,
    );
    expect(audit?.detail).toEqual({ queue: 'rab-email', count: 3 });
  });
});
