import { EmailOutboxJobType } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutboxService } from '../../email/email-outbox.service';
import { EmailQueueService } from '../../email/email-queue.service';
import { MfaSecurityNoticeKind, renderMfaSecurityNoticeEmail } from '../../email/templates';

/**
 * Account security step 1 (P7): queues the "your second factor changed" notice through the EXISTING email outbox (the
 * same path as the password-changed notice: an outbox row written in the caller's transaction, delivered by the Worker).
 * Job type NOTIFICATION (no schema change; `target_user_id` is always set, so the worker's deleted-target safeguard
 * applies). The body never contains a secret or code (`renderMfaSecurityNoticeEmail`).
 *
 * `manager` must be bound to the TARGET account's organisation (the outbox row is tenant-scoped under RLS). The row is
 * returned so the caller fast-publishes it only AFTER its transaction commits (`publish`).
 */
@Injectable()
export class MfaSecurityNoticeService {
  private readonly logger = new Logger(MfaSecurityNoticeService.name);

  constructor(
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
  ) {}

  async enqueue(manager: EntityManager, organisationId: string, userId: string, kind: MfaSecurityNoticeKind): Promise<{ id: string; organisationId: string } | null> {
    const [user] = await manager.query<Array<{ email: string; first_name: string | null }>>('SELECT email, first_name FROM core."user" WHERE id = $1', [userId]);
    if (!user?.email) {
      this.logger.warn(`mfa security notice (${kind}) not queued: account not visible in its organisation`);
      return null;
    }
    const row = await this.emailOutbox.enqueue(manager, {
      organisationId,
      jobType: EmailOutboxJobType.NOTIFICATION,
      recipientEmail: user.email,
      targetUserId: userId,
      rendered: renderMfaSecurityNoticeEmail({ firstName: user.first_name ?? '', kind }),
    });
    return { id: row.id, organisationId: row.organisationId };
  }

  /** Best effort, after commit: the dispatcher's poll loop delivers the row anyway. */
  publish(row: { id: string; organisationId: string } | null): void {
    if (row) void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
  }
}
