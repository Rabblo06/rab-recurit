import type { Job } from 'bullmq';

import { createEmailSendProcessor, type EmailSendProcessorDeps } from './email-send.processor';

/**
 * Regression (found by the 2026-10-15 live Docker acceptance run): a producer can fast-publish an outbox row from INSIDE its
 * still-open transaction, so this worker may look the row up before it is committed. Completing the job then stranded the row
 * as QUEUED until the dispatcher's 2-minute stale-QUEUED recovery (BullMQ dedupes the same jobId) — an Initial Manager resend
 * would not count until then. The job must instead FAIL this attempt so BullMQ retries it after its backoff, and must never send.
 */
describe('email send processor: outbox row not visible yet', () => {
  it('throws (BullMQ retries) instead of completing, and sends nothing', async () => {
    const send = jest.fn();
    const deps = {
      tenantContext: { runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn({ findOne: async () => null }) },
      emailService: { send },
      auditService: { record: jest.fn() },
    } as unknown as EmailSendProcessorDeps;
    const job = { data: { emailOutboxId: '00000000-0000-4000-8000-000000000001', organisationId: '00000000-0000-4000-8000-000000000002' } } as Job;

    await expect(createEmailSendProcessor(deps)(job)).rejects.toThrow(/not visible yet/);
    expect(send).not.toHaveBeenCalled();
  });
});
