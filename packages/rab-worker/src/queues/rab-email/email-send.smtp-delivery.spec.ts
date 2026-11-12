import { type Job, UnrecoverableError } from 'bullmq';

import { createEmailSendProcessor, EmailSendAttemptError, type EmailSendProcessorDeps, redactEmailAddresses, sanitizeErrorMessage } from './email-send.processor';

/**
 * email-twenty (owner decision 2026-11-06: Twenty CRM-style SMTP delivery, at-least-once). Unit level, no database, no
 * Redis: a scripted fake manager that behaves like one PostgreSQL TRANSACTION per `runInTenantContext` call — writes are
 * applied to the row only when the callback resolves, and discarded when it throws (a rollback). That is what makes the
 * revalidation-fault case below observable: before this change the claim shared its transaction with revalidation, so a
 * revalidation error rolled the counted claim back and the row could be retried for ever.
 *
 * The provider errors are shaped exactly as nodemailer's `_formatError` builds them (message + ": " + the server reply,
 * `code`, `responseCode`, `command`, `rejected`); the real-SMTP version of every case is
 * `email-smtp-twenty-delivery.integration.spec.ts`.
 */

const ROW_ID = '00000000-0000-4000-8000-0000000000f1';
const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const ADDRESS = 'staff.member@example.test';

interface Harness {
  deps: EmailSendProcessorDeps;
  send: jest.Mock;
  row: Record<string, unknown>;
  /** Committed status writes, in order (`+1` = the claim's SQL increment). */
  committed: Array<{ status: string; count: unknown; lastErrorCode?: unknown; lastErrorMessageSanitized?: unknown }>;
  audits: Array<{ action: unknown; metadata: unknown }>;
}

function harness(opts: { priorCount?: number; status?: string; failRevalidation?: boolean; hangRevalidation?: boolean; recipient?: string } = {}): Harness {
  const committed: Harness['committed'] = [];
  const audits: Harness['audits'] = [];
  const row: Record<string, unknown> = {
    id: ROW_ID,
    organisationId: ORG_ID,
    workspaceId: null,
    jobType: 'NOTIFICATION',
    status: opts.status ?? 'QUEUED',
    targetUserId: USER_ID,
    recipientEmail: opts.recipient ?? ADDRESS,
    renderedSubject: 'Shift confirmed',
    renderedHtml: '<p>hello</p>',
    renderedText: 'hello',
    attachmentFileId: null,
    attachmentKey: null,
    accountInviteId: null,
    passwordResetTokenId: null,
    infrastructureAttemptCount: opts.priorCount ?? 0,
    maxInfrastructureAttempts: 5,
    processingToken: null,
    providerCallStartedAt: null,
  };

  // Transactions run one at a time, as PostgreSQL's row lock serializes two claims of the same row.
  let queue: Promise<unknown> = Promise.resolve();
  const transaction = (fn: (manager: unknown) => Promise<unknown>) => {
    const run = queue.then(() => runTransaction(fn));
    queue = run.catch(() => undefined);
    return run;
  };
  const runTransaction = async (fn: (manager: unknown) => Promise<unknown>) => {
    const view: Record<string, unknown> = { ...row };
    const staged: Harness['committed'] = [];
    const stagedAudits: Harness['audits'] = [];
    const manager = {
      findOne: async () => ({ ...view }),
      query: async () => {
        // A Worker that dies between the committed claim and the revalidation transaction: this never returns.
        if (opts.hangRevalidation) return new Promise(() => undefined);
        // The revalidation's target-user check: a database fault (e.g. the connection terminated) when asked.
        if (opts.failRevalidation) throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
        return [{ '?column?': 1 }];
      },
      createQueryBuilder: () => {
        let payload: Record<string, unknown> = {};
        let where = '';
        let params: Record<string, unknown> = {};
        const b = {
          update: () => b,
          set: (p: Record<string, unknown>) => ((payload = p), b),
          where: (w: string, p: Record<string, unknown>) => ((where = w), (params = p ?? {}), b),
          returning: () => b,
          execute: async () => {
            if (Array.isArray(params.open) && !(params.open as string[]).includes(view.status as string)) return { affected: 0, raw: [] };
            if (params.token !== undefined && (view.status !== 'PROCESSING' || view.processingToken !== params.token)) return { affected: 0, raw: [] };
            if (where.includes('infrastructure_attempt_count < max_infrastructure_attempts') && (view.infrastructureAttemptCount as number) >= (view.maxInfrastructureAttempts as number)) {
              return { affected: 0, raw: [] };
            }
            if (typeof payload.status === 'string') view.status = payload.status;
            if (typeof payload.processingToken === 'string') view.processingToken = payload.processingToken;
            if (typeof payload.providerCallStartedAt === 'function') view.providerCallStartedAt = new Date();
            else if (payload.providerCallStartedAt === null) view.providerCallStartedAt = null;
            if (typeof payload.infrastructureAttemptCount === 'function') view.infrastructureAttemptCount = (view.infrastructureAttemptCount as number) + 1;
            else if (typeof payload.infrastructureAttemptCount === 'number') view.infrastructureAttemptCount = payload.infrastructureAttemptCount;
            if (typeof payload.lastErrorCode === 'string') view.lastErrorCode = payload.lastErrorCode;
            if (typeof payload.lastErrorMessageSanitized === 'string') view.lastErrorMessageSanitized = payload.lastErrorMessageSanitized;
            if (typeof payload.status === 'string') {
              staged.push({
                status: payload.status,
                count: typeof payload.infrastructureAttemptCount === 'function' ? '+1' : payload.infrastructureAttemptCount,
                lastErrorCode: payload.lastErrorCode,
                lastErrorMessageSanitized: payload.lastErrorMessageSanitized,
              });
            }
            return { affected: 1, raw: [{ infrastructure_attempt_count: view.infrastructureAttemptCount, max_infrastructure_attempts: view.maxInfrastructureAttempts }] };
          },
        };
        return b;
      },
      __audit: (action: unknown, metadata: unknown) => stagedAudits.push({ action, metadata }),
    };
    const result = await fn(manager); // a throw here discards `view`, `staged` and `stagedAudits`: the rollback
    Object.assign(row, view);
    committed.push(...staged);
    audits.push(...stagedAudits);
    return result;
  };

  const send = jest.fn(async (_options: { to: string; idempotencyKey: string }) => ({ provider: 'SMTP', providerMessageId: '<m-1@example.test>' }));
  const deps = {
    tenantContext: { runInTenantContext: (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => transaction(fn) },
    emailService: { send, ambiguousDeliverySafeToRetry: false },
    auditService: {
      record: jest.fn(async (manager: { __audit: (a: unknown, m: unknown) => void }, _ctx: unknown, action: unknown, opts: { metadata: unknown }) => manager.__audit(action, opts.metadata)),
    },
  } as unknown as EmailSendProcessorDeps;
  return { deps, send, row, committed, audits };
}

const jobOf = (attemptsMade = 0, generation = 0): Job =>
  ({ id: `email-outbox.${ROW_ID}.attempt.${generation}`, data: { emailOutboxId: ROW_ID, organisationId: ORG_ID }, attemptsMade, opts: { attempts: 5 } }) as unknown as Job;

/** nodemailer `_formatError(message, 'EENVELOPE', reply, 'RCPT TO')` for a refused recipient, reply echoing the mailbox. */
const rcptRejected = (reply: string) =>
  Object.assign(new Error(`Can't send mail - all recipients were rejected: ${reply}`), {
    code: 'EENVELOPE',
    response: reply,
    responseCode: Number(reply.slice(0, 3)),
    command: 'RCPT TO',
    rejected: [ADDRESS],
  });
const temporary = (address = ADDRESS) => rcptRejected(`451 4.7.1 <${address}>: Recipient address rejected: try again later`);
const permanent = () => rcptRejected(`550 5.1.1 <${ADDRESS}>: Recipient address rejected: User unknown`);
/** The socket closed after the DATA terminator, no reply (nodemailer: ECONNECTION, command 'API'): the server MAY have accepted it. */
const lostAfterData = () => Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'API' });

const errorOf = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('email-twenty: SMTP success', () => {
  it('an accepted send is SENT on the first attempt: one provider call, the stable delivery key, count 1', async () => {
    const h = harness();
    await createEmailSendProcessor(h.deps)(jobOf());
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0]).toMatchObject({ to: ADDRESS, idempotencyKey: `email-outbox:${ROW_ID}` });
    expect(h.committed.map((w) => w.status)).toEqual(['PROCESSING', 'SENT']);
    expect(h.row).toMatchObject({ status: 'SENT', infrastructureAttemptCount: 1 });
    expect(h.row.providerCallStartedAt).toBeInstanceOf(Date); // the marker was committed before the provider call
  });
});

describe('email-twenty: temporary rejection (SMTP 4xx) — retried through BullMQ, never past the cap', () => {
  it('451 at RCPT → RETRY with the attempt counted; BullMQ gets a sanitized, retryable error (not UnrecoverableError)', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(temporary());
    const error = await errorOf(createEmailSendProcessor(h.deps)(jobOf()));
    expect(error).toBeInstanceOf(EmailSendAttemptError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ code: 'EENVELOPE', responseCode: 451 });
    expect(h.row).toMatchObject({ status: 'RETRY', infrastructureAttemptCount: 1, lastErrorCode: 'EENVELOPE' });
  });

  it('451, 451, then accepted → SENT on attempt 3, one email', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(temporary()).mockRejectedValueOnce(temporary());
    const processor = createEmailSendProcessor(h.deps);
    await expect(processor(jobOf(0))).rejects.toBeInstanceOf(EmailSendAttemptError);
    await expect(processor(jobOf(1))).rejects.toBeInstanceOf(EmailSendAttemptError);
    await processor(jobOf(2));
    expect(h.row).toMatchObject({ status: 'SENT', infrastructureAttemptCount: 3 });
    expect(h.send).toHaveBeenCalledTimes(3);
  });
});

describe('email-twenty: permanent rejection (SMTP 5xx) — separate from retryable, never retried', () => {
  it('550 at RCPT → FAILED on the first attempt, UnrecoverableError, the error code and an audit row recorded', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(permanent());
    const error = await errorOf(createEmailSendProcessor(h.deps)(jobOf()));
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row).toMatchObject({ status: 'FAILED', infrastructureAttemptCount: 1, lastErrorCode: 'EENVELOPE' });
    expect(h.audits).toEqual([{ action: 'email.delivery_failed', metadata: expect.objectContaining({ errorCode: 'EENVELOPE', attempts: 1, retryable: false }) }]);
  });

  it('a later delivery of the same job does nothing (FAILED is never claimed again)', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(permanent());
    const processor = createEmailSendProcessor(h.deps);
    await expect(processor(jobOf(0))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processor(jobOf(1))).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('email-twenty: connection lost after DATA — at-least-once (owner requirement 5), not exactly-once', () => {
  it('ECONNECTION with no reply → RETRY, then re-sent and SENT: the provider was called twice (a possible duplicate, accepted)', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(lostAfterData());
    const processor = createEmailSendProcessor(h.deps);
    await expect(processor(jobOf(0))).rejects.toBeInstanceOf(EmailSendAttemptError);
    expect(h.row).toMatchObject({ status: 'RETRY', lastErrorCode: 'ECONNECTION' });
    await processor(jobOf(1));
    expect(h.row).toMatchObject({ status: 'SENT', infrastructureAttemptCount: 2 });
    expect(h.send).toHaveBeenCalledTimes(2);
    // Both attempts carried the SAME delivery key (the stable email identifier); SMTP itself cannot deduplicate on it.
    expect(h.send.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([`email-outbox:${ROW_ID}`, `email-outbox:${ROW_ID}`]);
  });

  it('a send-deadline timeout (ETIMEDOUT) is the same class: retryable', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(Object.assign(new Error('SMTP send did not complete within 25000 ms'), { code: 'ETIMEDOUT', timeoutType: 'SEND_DEADLINE' }));
    await expect(createEmailSendProcessor(h.deps)(jobOf())).rejects.toBeInstanceOf(EmailSendAttemptError);
    expect(h.row).toMatchObject({ status: 'RETRY', lastErrorCode: 'ETIMEDOUT' });
  });
});

describe('email-twenty: duplicate job delivery — the existing claim protection, unchanged', () => {
  it('the same job delivered again after SENT is a no-op: no second provider call, no write', async () => {
    const h = harness();
    const processor = createEmailSendProcessor(h.deps);
    await processor(jobOf(0, 0));
    const writes = h.committed.length;
    await processor(jobOf(0, 0)); // BullMQ redelivery
    await processor(jobOf(0, 1)); // an older/newer generation's job for the same row
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.committed).toHaveLength(writes);
  });

  it('two deliveries racing the same row: exactly one claim and one provider call', async () => {
    const h = harness();
    const processor = createEmailSendProcessor(h.deps);
    await Promise.all([processor(jobOf(0, 0)), processor(jobOf(0, 0))]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.committed.filter((w) => w.status === 'PROCESSING')).toHaveLength(1);
  });
});

describe('email-twenty: Worker crash while the provider holds the message (D-Q5b DELIVERY_UNCERTAIN path, kept)', () => {
  it('a send that never returns leaves the row PROCESSING with its marker; the stalled job re-run does not claim it or call the provider again', async () => {
    const h = harness();
    h.send.mockImplementationOnce(() => new Promise(() => undefined)); // the process dies inside sendMail: no outcome, ever
    const processor = createEmailSendProcessor(h.deps);
    void processor(jobOf(0, 0));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row).toMatchObject({ status: 'PROCESSING', infrastructureAttemptCount: 1 });
    expect(h.row.providerCallStartedAt).toBeInstanceOf(Date);
    // BullMQ's stalled check re-runs the job (maxStalledCount 1): the row is PROCESSING, so the claim refuses it.
    await expect(processor(jobOf(0, 0))).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);
    // After the 10-minute lease the dispatcher ends it FAILED DELIVERY_UNCERTAIN for SMTP (email-dispatch.job.spec.ts).
  });
});

describe('email-twenty: the provider-call marker describes the CURRENT attempt only (independent review I1)', () => {
  it("an earlier attempt marker (451, RETRY) is cleared by the next claim, so a crash before this attempt's own marker is a safe retry, not DELIVERY_UNCERTAIN", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(temporary());
    await expect(createEmailSendProcessor(h.deps)(jobOf(0))).rejects.toBeInstanceOf(EmailSendAttemptError);
    expect(h.row).toMatchObject({ status: 'RETRY' });
    expect(h.row.providerCallStartedAt).toBeInstanceOf(Date); // attempt 1 did reach the provider

    // Attempt 2: the claim commits, then the Worker dies before the revalidation transaction finishes.
    const crashing = harness({ hangRevalidation: true, priorCount: 1, status: 'RETRY' });
    crashing.row.providerCallStartedAt = new Date(Date.now() - 60_000);
    void createEmailSendProcessor(crashing.deps)(jobOf(1));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(crashing.row).toMatchObject({ status: 'PROCESSING', infrastructureAttemptCount: 2 });
    // No marker: lease recovery republishes it (nothing could have been sent) — email-dispatch.job.spec.ts / C1.
    expect(crashing.row.providerCallStartedAt).toBeNull();
    expect(crashing.send).not.toHaveBeenCalled();
  });
});

describe('email-twenty: retry exhaustion — bounded, and observable as FAILED', () => {
  it('451 on every attempt → RETRY x4, then FAILED at the cumulative cap of 5 with the code recorded; a 6th delivery is not claimed', async () => {
    const h = harness();
    h.send.mockImplementation(async () => {
      throw temporary();
    });
    const processor = createEmailSendProcessor(h.deps);
    for (const attemptsMade of [0, 1, 2, 3]) await expect(processor(jobOf(attemptsMade))).rejects.toBeInstanceOf(EmailSendAttemptError);
    const final = await errorOf(processor(jobOf(4)));
    expect(final).toBeInstanceOf(UnrecoverableError);
    expect(h.committed.filter((w) => w.status !== 'PROCESSING').map((w) => [w.status, w.count])).toEqual([
      ['RETRY', 1],
      ['RETRY', 2],
      ['RETRY', 3],
      ['RETRY', 4],
      ['FAILED', 5],
    ]);
    expect(h.row).toMatchObject({ status: 'FAILED', infrastructureAttemptCount: 5, lastErrorCode: 'EENVELOPE' });
    expect(h.audits.at(-1)).toEqual({ action: 'email.delivery_failed', metadata: expect.objectContaining({ errorCode: 'EENVELOPE', attempts: 5, retryable: true }) });
    await expect(processor(jobOf(0, 1))).resolves.toBeUndefined(); // e.g. a republished generation
    expect(h.send).toHaveBeenCalledTimes(5);
  });

  it('REGRESSION (owner requirement 11): a revalidation that keeps throwing a database error is counted and ends FAILED at 5 — it used to roll the claim back and loop for ever', async () => {
    const h = harness({ failRevalidation: true });
    const processor = createEmailSendProcessor(h.deps);
    for (let i = 0; i < 4; i += 1) await expect(processor(jobOf(i))).rejects.toBeInstanceOf(EmailSendAttemptError);
    expect(h.row).toMatchObject({ status: 'RETRY', infrastructureAttemptCount: 4, lastErrorCode: '57P01' });
    await expect(processor(jobOf(4))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.row).toMatchObject({ status: 'FAILED', infrastructureAttemptCount: 5 });
    expect(h.row.providerCallStartedAt).toBeNull(); // nothing was ever sent
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('email-twenty: SMTP errors are recorded and logged without the recipient address (owner requirement 3)', () => {
  it('neither the error BullMQ receives (its failedReason / the Worker log line) nor the outbox row carries the address', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(temporary());
    const processor = createEmailSendProcessor(h.deps);
    const retryError = (await errorOf(processor(jobOf(0)))) as Error;
    expect(retryError.message).not.toContain(ADDRESS);
    expect(retryError.message).toContain('451 4.7.1 <[address]>: Recipient address rejected');
    expect(retryError.message).toContain(ROW_ID);
    expect(String(retryError.stack)).not.toContain(ADDRESS);
    expect(JSON.stringify(retryError)).not.toContain(ADDRESS); // no `rejected` / `response` properties carried over
    expect(String(h.row.lastErrorMessageSanitized)).not.toContain(ADDRESS);

    h.send.mockRejectedValueOnce(permanent());
    const finalError = (await errorOf(processor(jobOf(1)))) as Error;
    expect(finalError).toBeInstanceOf(UnrecoverableError);
    expect(finalError.message).not.toContain(ADDRESS);
    expect(String(h.row.lastErrorMessageSanitized)).not.toContain(ADDRESS);
    expect(String(h.row.lastErrorMessageSanitized)).toContain('550 5.1.1');
  });

  it('redactEmailAddresses replaces every mailbox and leaves the rest of the reply', () => {
    expect(redactEmailAddresses('550 5.1.1 <a.b+c@mail.example.test>: unknown; cc x_y@z.io')).toBe('550 5.1.1 <[address]>: unknown; cc [address]');
    expect(redactEmailAddresses('421 4.3.2 service not available')).toBe('421 4.3.2 service not available');
  });

  it.each(['"john doe"@example.test', "o'brien@example.test", 'MiXeD.Case@Example.Test'])(
    'the row recipient is removed exactly, whatever its form (%s) — no local part survives (independent review L1)',
    async (recipient) => {
      const h = harness({ recipient });
      h.send.mockRejectedValueOnce(rcptRejected(`550 5.1.1 <${recipient.toLowerCase() === recipient ? recipient : recipient.toLowerCase()}>: Recipient address rejected: User unknown`));
      const error = (await errorOf(createEmailSendProcessor(h.deps)(jobOf()))) as Error;
      const localPart = recipient.split('@')[0]!.toLowerCase();
      for (const text of [error.message, String(error.stack), JSON.stringify(error), String(h.row.lastErrorMessageSanitized)]) {
        expect(text.toLowerCase()).not.toContain(localPart);
      }
      expect(String(h.row.lastErrorMessageSanitized)).toContain('550 5.1.1 <[address]>');
    },
  );

  it('keyword-labelled credentials are removed with their value, separator and auth scheme (independent review L3)', () => {
    const out = sanitizeErrorMessage(new Error('401 Authorization: Bearer re_live_SECRET1 token: abc123 password=hunter2'));
    expect(out).not.toMatch(/re_live_SECRET1|abc123|hunter2/);
  });

  it('a huge provider error is bounded before redaction: fast, and stored at 500 characters at most (independent review L2)', () => {
    const started = Date.now();
    const out = sanitizeErrorMessage(new Error('a'.repeat(5_000_000)));
    expect(Date.now() - started).toBeLessThan(200);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
