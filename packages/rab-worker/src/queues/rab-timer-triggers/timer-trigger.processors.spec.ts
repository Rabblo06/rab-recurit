import { TimerTriggerConsumer } from './timer-trigger.processors';

/**
 * T-1 review F1(b): the production wiring of the D-Q4b consumer. `handleTimerTrigger` asks for a READ ONLY decision
 * transaction with `runScoped(…, { readOnly: true })`; the consumer must forward that option to the tenant context (through
 * `runScopedForOrg`). Before T-1 the decision sent its own SET TRANSACTION READ ONLY, so a wiring that dropped the option
 * could not make it read-write; now it could. Real PostgreSQL proof (25006 inside the decision transaction, through this
 * same consumer): dq4b-timer-triggers.integration.spec.ts.
 */
describe('TimerTriggerConsumer wiring', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const WS = '33333333-3333-4333-8333-333333333333';
  const SUBJECT = '44444444-4444-4444-8444-444444444444';

  it('forwards { readOnly: true } for the decision transaction (shadow: the decision is the only transaction)', async () => {
    const opened: Array<{ ctx: unknown; options: unknown }> = [];
    const tenantContext = {
      runInTenantContext: async (ctx: unknown, fn: (m: unknown) => Promise<unknown>, options?: unknown) => {
        opened.push({ ctx, options });
        return fn({ query: async () => [] }); // the subject is not visible: the decision is a no-op
      },
    };
    const deps = {
      tenantContext,
      environmentService: { get: () => 10 },
      logger: { log: () => undefined, warn: () => undefined },
    };
    const consumer = new TimerTriggerConsumer({ get: () => deps } as never, { settings: { mode: 'shadow', enabled: () => true } } as never);
    const job = { id: 'j1', name: 'offer-expiry-trigger', data: { organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: Date.UTC(2026, 10, 4) }, attemptsStarted: 1, moveToDelayed: async () => undefined };

    await expect(consumer.trigger(job as never)).resolves.toEqual({ outcome: 'noop' });
    expect(opened).toEqual([{ ctx: { organisationId: ORG, workspaceId: WS, userId: '', role: '', actorType: 'worker' }, options: { readOnly: true } }]);
  });
});
