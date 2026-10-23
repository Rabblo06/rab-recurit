import { EmailOutboxJobType, EmailOutboxJobTypeType, EmailOutboxStatus } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutbox } from '../../../modules/identity/entities';

/**
 * F1 (Wave 1 lane S, migration EmailOutboxSecretBodyScrub1786719710000): job types whose rendered body ALWAYS carries a
 * bearer link token (account activation/invitation, password reset — self-service and admin-triggered —, member invitation).
 */
export const SECRET_BEARING_EMAIL_JOB_TYPES: ReadonlySet<string> = new Set<string>([
  EmailOutboxJobType.ACCOUNT_INVITATION,
  EmailOutboxJobType.PASSWORD_RESET,
  EmailOutboxJobType.MEMBER_INVITATION,
  EmailOutboxJobType.ORGANISATION_INVITATION,
]);

/** Any `token=` query parameter (`?token=`, `&token=`, HTML-escaped `&amp;token=`). Every token link this codebase renders uses it. */
const TOKEN_QUERY_PARAMETER = /[?&;]token=/i;

/**
 * Whether an outbox row's rendered body carries a secret (a bearer link token) and must therefore not outlive delivery.
 * The ONE rule, mirrored exactly by the database trigger `core.email_outbox_scrub_secret_body()` (the backstop for every
 * other writer): a secret-bearing job type, or any other email — e.g. the email-change verification, a NOTIFICATION —
 * whose body contains a `token=` query parameter. The worker clears such a body in the same write that makes the row
 * terminal (SENT / FAILED / CANCELLED); unsent rows keep it so retries still work.
 */
export function emailBodyCarriesSecret(row: { jobType: string; renderedHtml?: string | null; renderedText?: string | null }): boolean {
  if (SECRET_BEARING_EMAIL_JOB_TYPES.has(row.jobType)) return true;
  return TOKEN_QUERY_PARAMETER.test(row.renderedHtml ?? '') || TOKEN_QUERY_PARAMETER.test(row.renderedText ?? '');
}

export interface EnqueueEmailParams {
  organisationId: string;
  jobType: EmailOutboxJobTypeType;
  recipientEmail: string;
  targetUserId?: string;
  /** Workspace scope of the attachment (report emails). Ordinary account emails omit it. */
  workspaceId?: string | null;
  accountInviteId?: string;
  passwordResetTokenId?: string;
  /** `MEMBER_INVITATION` only — the pending invitation this email delivers (there is no target user yet). */
  memberInvitationId?: string;
  /** `ORGANISATION_INVITATION` only — the pending CEO invitation this email delivers (no organisation or user yet). */
  organisationInvitationId?: string;
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
      memberInvitationId: params.memberInvitationId ?? null,
      organisationInvitationId: params.organisationInvitationId ?? null,
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
