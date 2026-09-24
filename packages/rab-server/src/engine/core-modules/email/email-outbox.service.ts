import { EmailOutboxJobTypeType, EmailOutboxStatus } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutbox } from '../../../modules/identity/entities';

export interface EnqueueEmailParams {
  organisationId: string;
  jobType: EmailOutboxJobTypeType;
  recipientEmail: string;
  targetUserId?: string;
  /** Workspace scope of the attachment (report emails). Ordinary account emails omit it. */
  workspaceId?: string | null;
  accountInviteId?: string;
  passwordResetTokenId?: string;
  rendered: { subject: string; html?: string; text?: string };
  createdBy?: string | null;
  /**
   * A file ALREADY durably stored (a `stored_file` row) by the caller. Only the file ID travels: the send processor
   * reloads the row under RLS, re-reads the bytes from object storage and verifies their SHA-256 before attaching.
   * Never a path, an object key or bytes.
   */
  attachment?: { fileId: string; filename: string };
}

/**
 * The durable-write side of the transactional outbox — every caller wraps
 * `enqueue()` inside their OWN already-open `runInTenantContext` transaction
 * (never opens one itself, matching `AuditService.record()`'s established
 * shape), so the outbox row commits atomically with whatever business state
 * it accompanies. If that transaction commits, this row exists durably —
 * see `email-outbox.entity.ts`'s own doc comment for why that's the whole
 * point.
 *
 * This service only ever writes PENDING rows and reads by id — it never
 * publishes to BullMQ itself (that's `EmailDispatcher`, running from the
 * worker process on its own schedule, deliberately decoupled so a Redis
 * hiccup at enqueue time can never lose a durably-committed row) and never
 * sends email itself (that's `EmailSendProcessor`).
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  async enqueue(manager: EntityManager, params: EnqueueEmailParams): Promise<EmailOutbox> {
    const row = manager.create(EmailOutbox, {
      organisationId: params.organisationId,
      jobType: params.jobType,
      status: EmailOutboxStatus.PENDING,
      recipientEmail: params.recipientEmail,
      targetUserId: params.targetUserId,
      accountInviteId: params.accountInviteId,
      passwordResetTokenId: params.passwordResetTokenId,
      renderedSubject: params.rendered.subject,
      renderedHtml: params.rendered.html,
      renderedText: params.rendered.text,
      createdBy: params.createdBy ?? undefined,
      attachmentFileId: params.attachment?.fileId,
      workspaceId: params.workspaceId ?? undefined,
      attachmentFilename: params.attachment?.filename,
    });
    return manager.save(row);
  }

  /**
   * Best-effort, low-latency fast path — called right after the enclosing
   * transaction commits (never from inside it: publishing to Redis is a
   * network call, and doing it inside the DB transaction would just
   * reintroduce the exact "external call blocks the request" problem this
   * whole design exists to remove). A failure here is NEVER surfaced to the
   * HTTP caller and never retried inline — the row is already durably
   * PENDING regardless, and the dispatcher's own poll loop is the real
   * backstop that makes this optional rather than load-bearing. See
   * `email-dispatch.job.ts`'s own doc comment for the other half of this.
   */
  async tryFastPublish(publish: (emailOutboxId: string, organisationId: string) => Promise<void>, row: Pick<EmailOutbox, 'id' | 'organisationId'>): Promise<void> {
    try {
      await publish(row.id, row.organisationId);
    } catch (error) {
      this.logger.warn(`Fast-path publish failed for outbox row ${row.id} — the dispatcher's poll loop will pick it up.`, error as Error);
    }
  }
}
