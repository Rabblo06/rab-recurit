import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';

import { AuditSinkError, createSecurityAuditSink } from '@rab/server/engine/core-modules/audit-sink/security-audit-sink';
import type { AuditLogShippingRow } from '@rab/server/engine/core-modules/audit-events/build-security-audit-event';
import { parseAuditEventJobData, shipAuditEventJob } from './audit-event.handler';

/**
 * X1.1 Worker side (no database, no Redis): the ids-only payload is checked before any read; the row is re-read and
 * shipped redacted; a row the organisation cannot see (rolled back, forged scope) ships nothing; a sink failure throws so
 * BullMQ retries, and the next attempt delivers once the sink is back.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROW = '44444444-4444-4444-8444-444444444444';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const PW = `pw-${randomUUID()}`;

const row = (over: Partial<AuditLogShippingRow> = {}): AuditLogShippingRow => ({
  id: ROW,
  organisation_id: ORG,
  actor_user_id: ACTOR,
  target_user_id: null,
  action: 'platform_admin.granted',
  entity_type: 'user',
  entity_id: ACTOR,
  metadata: { reason: 'on-call', password: PW, email: 'ops.lead@example.com' },
  created_at: '2026-11-12T10:00:00.000Z',
  ...over,
});

function harness(read: AuditLogShippingRow | null = row()) {
  const lines: string[] = [];
  let down = false;
  const sink = createSecurityAuditSink(
    { mode: 'stdout', file: null, failure: 'refuse', production: true },
    {
      stdout: async (line) => {
        if (down) throw Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
        lines.push(line);
      },
    },
  );
  const readRow = jest.fn(async () => read);
  return { lines, readRow, setDown: (v: boolean) => (down = v), deps: { readRow, sink, processLabel: 'worker' } };
}

describe('audit-event Worker job (X1.1)', () => {
  it('re-reads the row in the payload organisation and writes the redacted event to the sink', async () => {
    const h = harness();
    await expect(shipAuditEventJob({ data: { organisationId: ORG, auditLogId: ROW } }, h.deps)).resolves.toEqual({ outcome: 'shipped' });
    expect(h.readRow).toHaveBeenCalledWith(ORG, ROW);
    expect(h.lines).toHaveLength(1);
    const event = JSON.parse(h.lines[0]!.replace(/^CREWFLOW_SECURITY_AUDIT /, ''));
    expect(event).toMatchObject({ type: 'platform_admin.granted', severity: 'critical', process: 'worker', organisationId: ORG, actorUserId: ACTOR });
    expect(event.detail).toMatchObject({ category: 'access_grant', auditLogId: ROW, metadata: { reason: 'on-call', password: '[REDACTED]', email: 'o***@example.com' } });
    expect(h.lines[0]).not.toContain(PW);
    expect(h.lines[0]).not.toContain('ops.lead@');
  });

  it('a row the organisation cannot see (rolled back after the hand-off, or a forged scope) ships nothing', async () => {
    const none = harness(null);
    await expect(shipAuditEventJob({ data: { organisationId: ORG, auditLogId: ROW } }, none.deps)).resolves.toEqual({ outcome: 'not-found' });
    expect(none.lines).toEqual([]);
    const other = harness(row({ organisation_id: OTHER }));
    await expect(shipAuditEventJob({ data: { organisationId: ORG, auditLogId: ROW } }, other.deps)).resolves.toEqual({ outcome: 'not-found' });
    expect(other.lines).toEqual([]);
  });

  it('a row whose action is not in the security catalogue is not shipped (defence in depth)', async () => {
    const h = harness(row({ action: 'offer.sent' }));
    await expect(shipAuditEventJob({ data: { organisationId: ORG, auditLogId: ROW } }, h.deps)).resolves.toEqual({ outcome: 'not-shipped' });
    expect(h.lines).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['no payload', undefined],
    ['an array', [ORG, ROW]],
    ['a missing id', { organisationId: ORG }],
    ['an extra key', { organisationId: ORG, auditLogId: ROW, action: 'user.deleted' }],
    ['a non-UUID organisation', { organisationId: 'org', auditLogId: ROW }],
    ['a nested id', { organisationId: ORG, auditLogId: { id: ROW } }],
  ])('ABUSE: %s fails without a retry and without a database read', async (_label, data) => {
    const h = harness();
    await expect(shipAuditEventJob({ data }, h.deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.readRow).not.toHaveBeenCalled();
    expect(() => parseAuditEventJobData(data)).toThrow(UnrecoverableError);
  });

  it('a sink failure throws (BullMQ retries the job); the next attempt after the sink recovers delivers', async () => {
    const h = harness();
    h.setDown(true);
    await expect(shipAuditEventJob({ data: { organisationId: ORG, auditLogId: ROW } }, h.deps)).rejects.toBeInstanceOf(AuditSinkError);
    expect(h.lines).toEqual([]);
    h.setDown(false);
    await expect(shipAuditEventJob({ data: { organisationId: ORG, auditLogId: ROW } }, h.deps)).resolves.toEqual({ outcome: 'shipped' });
    expect(h.lines).toHaveLength(1);
  });
});
