import type { Job } from 'bullmq';

import { createEmailSendProcessor, type EmailSendProcessorDeps } from './email-send.processor';

/**
 * D-Q5 test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q5.1 and §D-Q5.6; audit §13 #3 and #4).
 *
 * Unit level, scripted fake manager: no database, no Redis. The fake records every `.set(...)` the processor writes to
 * `email_outbox` and can make the SENT write fail, which is the only way to reach audit finding #3 deterministically.
 *
 * CHARACTERISATION (pass today, pin current behaviour):
 *  - #4 `infrastructure_attempt_count` is JOB-relative (`job.attemptsMade + 1`), so a row republished with a new
 *    generation starts counting again from 1, and `isFinal` compares against the NEW job's attempts.
 *  - #3 a successful provider send whose SENT write fails three times is then written RETRY (if the database is back)
 *    and rethrown as retryable, so BullMQ runs the job again and the provider is called a SECOND time.
 *
 * FAILING-FIRST (gated, DQ45_PENDING_SPECS=1): the PROPOSED cumulative counter for #4. Owner confirmation is listed in
 * the plan (it makes the existing cap of 5 apply across generations instead of per generation). #3 has NO pending spec:
 * its fix changes the duplicate-vs-missed trade-off and is an owner decision (plan §Owner decisions, OD-5).
 */

const ROW_ID = '00000000-0000-4000-8000-0000000000e1';
const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';

interface Harness {
  deps: EmailSendProcessorDeps;
  writes: Array<Record<string, unknown>>;
  send: jest.Mock;
  /** Mutable row state the fake manager serves (status follows the last successful write). */
  row: Record<string, unknown>;
}

function harness(opts: { priorCount: number; failSentWrites?: number }): Harness {
  const writes: Array<Record<string, unknown>> = [];
  let sentFailuresLeft = opts.failSentWrites ?? 0;
  const row: Record<string, unknown> = {
    id: ROW_ID,
    organisationId: ORG_ID,
    workspaceId: null,
    jobType: 'NOTIFICATION',
    status: 'QUEUED',
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
    maxInfrastructureAttempts: 5,
  };
  const manager = {
    findOne: async () => ({ ...row }),
    query: async () => [{ '?column?': 1 }], // the target user still exists
    createQueryBuilder: () => {
      let payload: Record<string, unknown> = {};
      const b = {
        update: () => b,
        set: (p: Record<string, unknown>) => {
          payload = p;
          return b;
        },
        where: () => b,
        execute: async () => {
          if (payload.status === 'SENT' && sentFailuresLeft > 0) {
            sentFailuresLeft -= 1;
            throw new Error('connection terminated unexpectedly'); // a generic DB blip: classified retryable
          }
          writes.push(payload);
          if (typeof payload.status === 'string') row.status = payload.status;
          if (typeof payload.infrastructureAttemptCount === 'number') row.infrastructureAttemptCount = payload.infrastructureAttemptCount;
          return { affected: 1 };
        },
      };
      return b;
    },
  };
  const send = jest.fn(async () => ({ provider: 'smtp', providerMessageId: 'm-1' }));
  const deps = {
    tenantContext: { runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn(manager) },
    emailService: { send },
    auditService: { record: jest.fn(async () => undefined) },
  } as unknown as EmailSendProcessorDeps;
  return { deps, writes, send, row };
}

const jobOf = (attemptsMade: number, generation = 1): Job =>
  ({ id: `email-outbox.${ROW_ID}.attempt.${generation}`, data: { emailOutboxId: ROW_ID, organisationId: ORG_ID }, attemptsMade, opts: { attempts: 5 } }) as unknown as Job;

const statusWrites = (h: Harness) => h.writes.filter((w) => typeof w.status === 'string').map((w) => ({ status: w.status, count: w.infrastructureAttemptCount }));

describe('D-Q5 characterisation §13 #4: infrastructure_attempt_count is job-relative', () => {
  it('a republished row (prior count 4) that sends on its first new-generation attempt is written SENT with count 1', async () => {
    const h = harness({ priorCount: 4 });
    await createEmailSendProcessor(h.deps)(jobOf(0, 2));
    expect(statusWrites(h)).toEqual([{ status: 'PROCESSING', count: undefined }, { status: 'SENT', count: 1 }]);
  });

  it('a republished row (prior count 4, max 5) that fails retryably is written RETRY with count 1, not FAILED', async () => {
    const h = harness({ priorCount: 4 });
    h.send.mockRejectedValueOnce(Object.assign(new Error('greeting never received'), { code: 'ETIMEDOUT' }));
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 2))).rejects.toThrow(/greeting never received/);
    expect(statusWrites(h)).toEqual([{ status: 'PROCESSING', count: undefined }, { status: 'RETRY', count: 1 }]);
  });
});

describe('D-Q5 characterisation §13 #3: a failed SENT write after a real send leads to a second provider call', () => {
  it('SENT write fails 3x → RETRY written, retryable rethrow → the BullMQ retry calls the provider again', async () => {
    const h = harness({ priorCount: 0, failSentWrites: 3 });
    const processor = createEmailSendProcessor(h.deps);
    await expect(processor(jobOf(0, 0))).rejects.toThrow(/connection terminated/);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row.status).toBe('RETRY'); // not PROCESSING-with-marker, so the dispatcher's DELIVERY_UNCERTAIN gate never sees it

    // BullMQ's own retry of the same job (attemptsMade 1): the row is RETRY, the claim succeeds, the email is sent AGAIN.
    await processor(jobOf(1, 0));
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.row.status).toBe('SENT');
  }, 10_000);

  it.todo('OWNER DECISION OD-5: what a failed SENT write after a confirmed provider send should do (duplicate vs. manual review)');
});

const describePending = process.env.DQ45_PENDING_SPECS === '1' ? describe : describe.skip;

describePending('PENDING D-Q5.1 (failing-first; PROPOSED, owner confirmation OC-1): the attempt counter is cumulative across generations', () => {
  it('a republished row (prior count 4, max 5) that fails retryably reaches the cap: FAILED with count 5', async () => {
    const h = harness({ priorCount: 4 });
    h.send.mockRejectedValueOnce(Object.assign(new Error('greeting never received'), { code: 'ETIMEDOUT' }));
    await expect(createEmailSendProcessor(h.deps)(jobOf(0, 2))).rejects.toThrow();
    expect(statusWrites(h).at(-1)).toEqual({ status: 'FAILED', count: 5 });
  });

  it('a successful send on a republished row records the cumulative count (prior 4 → 5)', async () => {
    const h = harness({ priorCount: 4 });
    await createEmailSendProcessor(h.deps)(jobOf(0, 2));
    expect(statusWrites(h).at(-1)).toEqual({ status: 'SENT', count: 5 });
  });
});
