import { auditEventsHealthCard } from './admin-health.service';

/**
 * X1.1 owner guard (2026-11-12): the platform-admin Health tab shows failed-login audit events dropped above the 10,000
 * audit-queue backlog (durable total + this API process), with fixed strings only.
 */
describe('Health tab: security audit events card (X1.1)', () => {
  it('no drops: healthy, with the total, this process and the last backlog reading', () => {
    expect(auditEventsHealthCard({ enabled: true, total: 0, sinceProcessStart: 0, lastBacklog: 12 })).toEqual({
      key: 'auditEvents',
      status: 'healthy',
      detail: 'Failed-login events over the 10,000 backlog: 0 dropped in total · 0 by this API process · queue backlog 12',
      latencyMs: null,
    });
  });

  it('drops (anywhere, or in this process): warning, counts shown', () => {
    expect(auditEventsHealthCard({ enabled: true, total: 42, sinceProcessStart: 3, lastBacklog: 10_250 })).toMatchObject({
      status: 'warning',
      detail: 'Failed-login events over the 10,000 backlog: 42 dropped in total · 3 by this API process · queue backlog 10250',
    });
    expect(auditEventsHealthCard({ enabled: true, total: 0, sinceProcessStart: 1, lastBacklog: null }).status).toBe('warning');
  });

  it('total unreadable: warning, said plainly; shipper off (development): healthy, said plainly', () => {
    expect(auditEventsHealthCard({ enabled: true, total: null, sinceProcessStart: 0, lastBacklog: null })).toMatchObject({ status: 'warning', detail: expect.stringContaining('total unknown') });
    expect(auditEventsHealthCard({ enabled: false, total: null, sinceProcessStart: 0, lastBacklog: null })).toMatchObject({ status: 'healthy', detail: expect.stringContaining('off') });
    expect(auditEventsHealthCard(null).key).toBe('auditEvents');
  });
});
