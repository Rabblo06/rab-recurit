import { DelayedError, type Job, UnrecoverableError } from 'bullmq';

import { createEmailSendProcessor, deliveryKeyFor, type EmailSendProcessorDeps } from './email-send.processor';

/**
 * D-Q5b (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.1 and §5.6.4; audit §13 #3 and #4; owner approval 2026-11-04 OC-1, OD-5).
 * Ported from the failing-first preparation on `phase-d/dq45-test-prep` (514a4e15): the characterisation tests that pinned
 * the defects there now assert the fixed behaviour, and the gated PENDING block is ungated.
 *
 * Unit level, scripted fake manager: no database, no Redis. The fake keeps one row, applies the claim's
 * `infrastructure_attempt_count + 1` and `infrastructure_attempt_count < max_infrastructure_attempts` gate the way
 * PostgreSQL would, returns the RETURNING row, and can make the SENT write fail — the only way to reach audit #3
 * deterministically. The real-database version of every case is `dq5b-cumulative-attempts.integration.spec.ts`.
 *
 * OC-1: the attempt cap of 5 is CUMULATIVE across generations. Every claim counts one attempt; a republished row (new
 * BullMQ job, `attemptsMade` back at 0) continues from the count the row already carries.
 * OD-5 (Option B): after a confirmed provider send, a failed SENT write leaves the row PROCESSING for lease recovery and
 * ends the job (UnrecoverableError) — never RETRY, never a second provider call from BullMQ.
 */

const ROW_ID = '00000000-0000-4000-8000-0000000000e1';
const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';

interface Harness {
  deps: EmailSendProcessorDeps;
  writes: Array<Record<string, unknown>>;
  send: jest.Mock;
  /** Mutable row state the fake manager serves (status and count follow each successful write). */
  row: Record<string, unknown>;
}

function harness(opts: { priorCount: number; status?: string; max?: number; failSentWrites?: number; claimReturnsNothing?: boolean }): Harness {
  const writes: Array<Record<string, unknown>> = [];
  let sentFailuresLeft = opts.failSentWrites ?? 0;
  const row: Record<string, unknown> = {
    id: ROW_ID,
    organisationId: ORG_ID,
    workspaceId: null,
    jobType: 'NOTIFICATION',
    status: opts.status ?? 'QUEUED',
    targetUserId: USER_ID,
    recipientEmail: 'staff@example.test',
    renderedSubject: 'Shift reminder',
    renderedHtml: '<p>hello</p>',
    renderedText: 'hello',
    attachmentFileId: null,
    attachmentKey: null,
    accountInviteId: null,
    passwordResetTokenId: null,
    infrastructureAttemptCount: opts.priorCount,
    maxInfrastructureAttempts: opts.max ?? 5,
    processingToken: null,
  };
  const manager = {
    findOne: async () => ({ ...row }),
    query: async () => [{ '?column?': 1 }], // the target user still exists
    createQueryBuilder: () => {
      let payload: Record<string, unknown> = {};
      let where = '';
      let params: Record<string, unknown> = {};
      const b = {
        update: () => b,
        set: (p: Record<string, unknown>) => {
          payload = p;
          return b;
        },
        where: (w: string, p: Record<string, unknown>) => {
          where = w;
          params = p ?? {};
          return b;
        },
        returning: () => b,
        execute: async () => {
          // The two predicates the processor's writes use, evaluated against the fake row like PostgreSQL would.
          if (Array.isArray(params.open) && !(params.open as string[]).includes(row.status as string)) return { affected: 0, raw: [] };
          if (params.token !== undefined && (row.status !== 'PROCESSING' || row.processingToken !== params.token)) return { affected: 0, raw: [] };
          if (where.includes('infrastructure_attempt_count < max_infrastructure_attempts') && (row.infrastructureAttemptCount as number) >= (row.maxInfrastructureAttempts as number)) {
            return { affected: 0, raw: [] };
          }
          if (payload.status === 'SENT' && sentFailuresLeft > 0) {
            sentFailuresLeft -= 1;
            throw new Error('connection terminated unexpectedly'); // a generic DB blip on the SENT write
          }
          writes.push(payload);
          if (typeof payload.status === 'string') row.status = payload.status;
          if (typeof payload.processingToken === 'string') row.processingToken = payload.processingToken;
          if (typeof payload.infrastructureAttemptCount === 'function') row.infrastructureAttemptCount = (row.infrastructureAttemptCount as number) + 1;
          else if (typeof payload.infrastructureAttemptCount === 'number') row.infrastructureAttemptCount = payload.infrastructureAttemptCount;
          const raw = opts.claimReturnsNothing
            ? []
            : [{ infrastructure_attempt_count: row.infrastructureAttemptCount, max_infrastructure_attempts: row.maxInfrastructureAttempts }];
          return { affected: 1, raw };
        },
      };
      return b;
    },
  };
  const send = jest.fn(async (_options: { idempotencyKey: string }) => ({ provider: 'smtp', providerMessageId: 'm-1' }));
  const deps = {
    tenantContext: { runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn(manager) },
    emailService: { send },
    auditService: { record: jest.fn(async () => undefined) },
  } as unknown as EmailSendProcessorDeps;
  return { deps, writes, send, row };
}

const jobOf = (attemptsMade: number, generation = 1, extra: Record<string, unknown> = {}): Job =>
  ({ id: `email-outbox.${ROW_ID}.attempt.${generation}`, data: { emailOutboxId: ROW_ID, organisationId: ORG_ID }, attemptsMade, opts: { attempts: 5 }, ...extra }) as unknown as Job;

/** Status writes with the count each one recorded (`'+1'` = the claim's SQL increment). */
const statusWrites = (h: Harness) =>
  h.writes
    .filter((w) => typeof w.status === 'string')
    .map((w) => ({ status: w.status, count: typeof w.infrastructureAttemptCount === 'function' ? '+1' : w.infrastructureAttemptCount }));

const transient = () => Object.assign(new Error('greeting never received'), { code: 'ETIMEDOUT' });

describe('D-Q5b §13 #4 (OC-1): infrastructure_attempt_count is cumulative across generations', () => {
  it('the claim itself counts the attempt (SQL increment) and only claims a row below its cap', async () => {
    const h = harness({ priorCount: 0 });
    await createEmailSendProcessor(h.deps)(jobOf(0, 0));
    expect(statusWrites(h)).toEqual([{ status: 'PROCESSING', count: '+1' }, { status: 'SENT', count: 1 }]);
  });

  it('a republished row (prior count 4) that sends on its first new-generation attempt is written SENT with count 5', async () => {
    const h = harness({ priorCount: 4 });
    await createEmailSendProcessor(h.deps)(jobOf(0, 2));
    expect(statusWrites(h).at(-1)).toEqual({ status: 'SENT', count: 5 });
  });

  it('a republished row (prior count 4, max 5) that fails retryably reaches the cap: FAILED with count 5, UnrecoverableError', async () => {
    const h = harness({ priorCount: 4 });
    h.send.mockRejectedValueOnce(transient());
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 2))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(statusWrites(h).at(-1)).toEqual({ status: 'FAILED', count: 5 });
  });

  it('a republished row below the cap (prior 2) fails retryably: RETRY with count 3, rethrown for the BullMQ backoff', async () => {
    const h = harness({ priorCount: 2 });
    h.send.mockRejectedValueOnce(transient());
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 1))).rejects.toThrow(/greeting never received/);
    expect(statusWrites(h).at(-1)).toEqual({ status: 'RETRY', count: 3 });
  });

  it('across generations the cap is 5 in total: 3 attempts in generation 0 + 2 in generation 1, then FAILED — never 5 per generation', async () => {
    const h = harness({ priorCount: 0 });
    h.send.mockImplementation(async () => {
      throw transient();
    });
    const processor = createEmailSendProcessor(h.deps);
    for (const attemptsMade of [0, 1, 2]) await expect(processor(jobOf(attemptsMade, 0))).rejects.toThrow(/greeting never received/);
    expect(h.row).toMatchObject({ status: 'RETRY', infrastructureAttemptCount: 3 });
    // The BullMQ job was lost; the dispatcher's stale-RETRY recovery republishes generation 1 (the row moves RETRY → QUEUED).
    h.row.status = 'QUEUED';
    await expect(processor(jobOf(0, 1))).rejects.toThrow(/greeting never received/);
    expect(h.row).toMatchObject({ status: 'RETRY', infrastructureAttemptCount: 4 });
    await expect(processor(jobOf(1, 1))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.row).toMatchObject({ status: 'FAILED', infrastructureAttemptCount: 5 });
    expect(h.send).toHaveBeenCalledTimes(5);
  });

  it('a row that already carries 5 cumulative attempts is never claimed again: no PROCESSING write, no provider call', async () => {
    const h = harness({ priorCount: 5, status: 'RETRY' });
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 3))).resolves.toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.row.status).toBe('RETRY'); // left for the dispatcher's STUCK_LEASE_ATTEMPTS_EXHAUSTED gate
  });

  it('fail closed: a claim that returns no attempt count sends nothing (the claim transaction is rolled back by the throw)', async () => {
    const h = harness({ priorCount: 0, claimReturnsNothing: true });
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 0))).rejects.toThrow(/attempt count/);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a provider-throttled attempt (Retry-After) gives its count back, as before: RETRY with the prior count, DelayedError', async () => {
    const h = harness({ priorCount: 1 });
    h.send.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { retryable: true, retryAfterMs: 2_000 }));
    const moveToDelayed = jest.fn(async () => undefined);
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 1, { token: 'lock', attemptsStarted: 1, moveToDelayed }))).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(statusWrites(h).at(-1)).toEqual({ status: 'RETRY', count: 1 });
  });

  it('a throttled failure on the last cumulative attempt still ends FAILED at the cap (unchanged rule: the last attempt is not re-delayed)', async () => {
    const h = harness({ priorCount: 4 });
    h.send.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { retryable: true, retryAfterMs: 2_000 }));
    const moveToDelayed = jest.fn(async () => undefined);
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 1, { token: 'lock', attemptsStarted: 1, moveToDelayed }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(statusWrites(h).at(-1)).toEqual({ status: 'FAILED', count: 5 });
  });
});

describe('D-Q5b §13 #3 (OD-5 Option B): a failed SENT write after a confirmed send never leads to a second provider call', () => {
  it('SENT write fails 3x → no RETRY/FAILED write, row stays PROCESSING with its claim, UnrecoverableError (BullMQ does not retry)', async () => {
    const h = harness({ priorCount: 0, failSentWrites: 3 });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const processor = createEmailSendProcessor(h.deps);
    const error = await processor(jobOf(0, 0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row).toMatchObject({ status: 'PROCESSING', infrastructureAttemptCount: 1 });
    expect(statusWrites(h)).toEqual([{ status: 'PROCESSING', count: '+1' }]);

    // The log now says what actually happens (it used to claim PROCESSING while the row was written RETRY).
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Strings only (CodeRabbit on #52): a raw QueryFailedError would print its bound parameters, the fencing token included.
    expect(errorSpy.mock.calls.flat().every((arg) => typeof arg === 'string')).toBe(true);
    expect(logged).toMatch(/Last error: Error\./);
    expect(logged).not.toContain(String(h.row.processingToken));
    errorSpy.mockRestore();
    expect(logged).toMatch(/PROVIDER SUCCEEDED/);
    expect(logged).toMatch(/left PROCESSING/);
    expect(logged).toMatch(/not retried/);
    expect(logged).not.toContain('staff@example.test'); // ids only, never the address

    // Even if the same job were delivered again, the PROCESSING row cannot be claimed: no second send.
    await expect(processor(jobOf(1, 0))).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('a SENT write that fails once and then succeeds is still SENT (the local retry is unchanged), one provider call', async () => {
    const h = harness({ priorCount: 2, failSentWrites: 1 });
    await createEmailSendProcessor(h.deps)(jobOf(0, 1));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(statusWrites(h).at(-1)).toEqual({ status: 'SENT', count: 3 });
  });

  it('a real provider failure is still classified (RETRY) — only a failure AFTER the confirmed send takes the no-resend path', async () => {
    const h = harness({ priorCount: 0 });
    h.send.mockRejectedValueOnce(transient());
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 0))).rejects.toThrow(/greeting never received/);
    expect(statusWrites(h).at(-1)).toEqual({ status: 'RETRY', count: 1 });
  });

  it('the provider is always given the stable per-row delivery key (what lets a Resend re-presentation dedupe)', async () => {
    const h = harness({ priorCount: 0 });
    await createEmailSendProcessor(h.deps)(jobOf(0, 0));
    expect(h.send.mock.calls[0]![0].idempotencyKey).toBe(deliveryKeyFor(ROW_ID));
  });
});
