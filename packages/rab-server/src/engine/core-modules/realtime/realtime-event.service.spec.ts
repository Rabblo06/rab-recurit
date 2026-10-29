import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EnvironmentService } from '../environment/environment.service';
import { RealtimeEventService, RealtimeEventType } from './realtime-event.service';

/**
 * Phase A gating — `RealtimeEventService.record()` writes nothing when `REALTIME_ENABLED` is false, and is unchanged
 * when it is true. The real-database proof (FORCE RLS, real producers) is
 * `__tests__/integration/realtime-push-gating.integration.spec.ts`; this pins the contract cheaply.
 */
describe('RealtimeEventService — REALTIME_ENABLED gating', () => {
  const params = { organisationId: 'org-1', workspaceId: 'ws-1', targetUserId: 'user-1', eventKey: 'offer.sent:o1', eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: 'o1' };
  const serviceWith = (enabled: boolean) => new RealtimeEventService({ get: (key: string) => (key === 'REALTIME_ENABLED' ? enabled : undefined) } as unknown as EnvironmentService);
  const managerReturning = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue(rows) });

  it('disabled: returns null and runs no SQL at all', async () => {
    const manager = managerReturning([{ id: 'never' }]);
    await expect(serviceWith(false).record(manager as unknown as EntityManager, params)).resolves.toBeNull();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('disabled: an unknown event type is still rejected (the type check runs before the flag check — fail closed)', async () => {
    const manager = managerReturning([]);
    await expect(serviceWith(false).record(manager as unknown as EntityManager, { ...params, eventType: 'bogus.type' })).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('enabled: inserts exactly as before and returns the new id (null on a dedup conflict)', async () => {
    const manager = managerReturning([{ id: 'evt-1' }]);
    await expect(serviceWith(true).record(manager as unknown as EntityManager, params)).resolves.toBe('evt-1');
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, values] = manager.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO core\.realtime_event/);
    expect(sql).toMatch(/ON CONFLICT \(event_key\) DO NOTHING/);
    expect(values).toEqual(['org-1', 'ws-1', 'user-1', 'offer.sent:o1', 'offer.sent', 'offer', 'o1', '{}']);
    await expect(serviceWith(true).record(managerReturning([]) as unknown as EntityManager, params)).resolves.toBeNull();
  });
});
