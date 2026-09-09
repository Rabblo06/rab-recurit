import { EmailOutboxStatus } from '@rab/shared';
import { Job, UnrecoverableError } from 'bullmq';
import { EntityManager } from 'typeorm';

import { AccountInvite, EmailOutbox, PasswordResetToken } from '../../modules/identity/entities';
import { AuditAction, AuditActionType, AuditService } from '../../engine/core-modules/audit/audit.service';
import { EmailService } from '../../engine/core-modules/email/email.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { EmailQueueJobData } from '../../engine/core-modules/email/email-queue.constants';

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Network/transport-level failures — worth retrying, since the SAME send
 * attempted a few seconds later has a real chance of succeeding (a blip, a
 * momentary DNS hiccup, a provider rate limit). Matched against the error's
 * own `code` (Node/nodemailer's convention — `ETIMEDOUT`, `ECONNRESET`,
 * etc.) first, falling back to the message for providers (Resend) that
 * don't set `.code` the same way.
 */
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN', 'ESOCKET', 'ETIMEOUT']);
const RETRYABLE_MESSAGE_PATTERNS = [/rate.?limit/i, /too many requests/i, /\b429\b/, /\b5\d\d\b/, /temporarily/i, /timeout/i];

/**
 * `false` here means "don't bother retrying — the next attempt would fail
 * for the exact same reason" (a permanently invalid recipient, invalid
 * credentials, a malformed request) — those short-circuit to FAILED via
 * `UnrecoverableError` regardless of how many attempts remain configured.
 * Never guesses beyond what the error itself signals — an unrecognised
 * error is treated as retryable by default (fails safe toward "try again",
 * not toward silently giving up on something transient).
 */
function isRetryable(error: unknown): boolean {
  const err = error as { code?: string; message?: string; responseCode?: number };
  if (err?.code && RETRYABLE_CODES.has(err.code)) return true;
  if (typeof err?.responseCode === 'number' && err.responseCode >= 500) return true;
  if (typeof err?.responseCode === 'number' && err.responseCode === 429) return true;
  // A permanent SMTP rejection (5xx *response code*, not the message text)
  // is the clearest non-retryable signal nodemailer gives us. Everything
  // else — unrecognised codes, unrecognised providers — falls through to
  // the message-pattern check, then to "retryable" by default.
  const message = err?.message ?? String(error);
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function sanitizeErrorMessage(error: unknown): string {
  const message = (error as { message?: string })?.message ?? String(error);
  // Defense-in-depth, not the primary control — nothing in this codebase's
  // email path ever puts a password/API key into an Error message (verified
  // by reading every driver), but a future driver change is exactly the
  // kind of regression this guards against without needing to trust that
  // discipline holds forever.
  const scrubbed = message.replace(/(password|pass|apikey|api_key|authorization|token)[^\s,;]{0,80}/gi, '[redacted]');
  return scrubbed.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export interface EmailSendProcessorDeps {
  tenantContext: TenantContextService;
  emailService: EmailService;
  auditService: AuditService;
}

/**
 * `ACCOUNT_INVITATION` keeps its own long-established action names (existing
 * tests assert `action === 'user.invited'` directly) — every other
 * `EmailOutboxJobType` (password reset/updated, welcome, suspension notice,
 * notification) resolves through the generic `EMAIL_SENT`/
 * `EMAIL_DELIVERY_FAILED` pair instead, with `metadata.jobType` disambiguating.
 */
function auditActionsForJobType(jobType: string): { sent: AuditActionType; failed: AuditActionType } {
  if (jobType === 'ACCOUNT_INVITATION') return { sent: AuditAction.INVITE_EMAIL_SENT, failed: AuditAction.INVITE_EMAIL_FAILED };
  return { sent: AuditAction.EMAIL_SENT, failed: AuditAction.EMAIL_DELIVERY_FAILED };
}

/**
 * The BullMQ processor — one call per delivery attempt (BullMQ itself
 * re-invokes this on each retry, per the queue's own `attempts`/`backoff`
 * config set in `EmailQueueService.publish`). Binds real `rab_app` tenant
 * context via `organisationId` from the job payload (never owner/bypass
 * access — see `email-dispatch.job.ts`'s doc comment for why that's
 * deliberately confined to the dispatcher, not here).
 *
 * Idempotent by construction (A12): the very first thing this does after
 * binding context is re-read the row's live status — SENT or CANCELLED both
 * return immediately, no second send attempt, regardless of how many times
 * BullMQ redelivers the same job id.
 */
export function createEmailSendProcessor(deps: EmailSendProcessorDeps) {
  return async function processEmailSendJob(job: Job<EmailQueueJobData>): Promise<void> {
    const { emailOutboxId, organisationId } = job.data;
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: '', role: '' };

    const outcome = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await manager.findOne(EmailOutbox, { where: { id: emailOutboxId } });
      if (!row) return { skip: true as const };

      if (row.status === EmailOutboxStatus.SENT) return { skip: true as const };
      if (row.status === EmailOutboxStatus.CANCELLED) return { skip: true as const };

      // Race-safe claim: only one worker (or one retry-in-flight) can move
      // a row into PROCESSING at a time. Whichever loses this UPDATE simply
      // has nothing left to do — the winner owns the send.
      const claim = await manager
        .createQueryBuilder()
        .update(EmailOutbox)
        .set({ status: EmailOutboxStatus.PROCESSING, processingAt: () => 'now()' })
        .where('id = :id AND status IN (:...open)', { id: row.id, open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.RETRY] })
        .execute();
      if (!claim.affected) return { skip: true as const };

      const revalidation = await revalidate(manager, row);
      if (!revalidation.ok) {
        await manager
          .createQueryBuilder()
          .update(EmailOutbox)
          .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()', lastErrorMessageSanitized: revalidation.reason })
          .where('id = :id', { id: row.id })
          .execute();
        return { skip: true as const };
      }

      return { skip: false as const, row };
    });

    if (outcome.skip) return;
    const row = outcome.row!;

    try {
      await deps.emailService.send({
        to: row.recipientEmail,
        subject: row.renderedSubject,
        html: row.renderedHtml ?? undefined,
        text: row.renderedText ?? undefined,
      });
    } catch (error) {
      // Always throws — either the original error (BullMQ retries per its
      // own attempts/backoff config) or UnrecoverableError (BullMQ stops
      // immediately) — after persisting RETRY/FAILED state either way.
      await handleSendFailure(deps, ctx, row, job, error);
    }

    await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
      await manager
        .createQueryBuilder()
        .update(EmailOutbox)
        .set({ status: EmailOutboxStatus.SENT, sentAt: () => 'now()', infrastructureAttemptCount: job.attemptsMade + 1 })
        .where('id = :id', { id: row.id })
        .execute();
      await deps.auditService.record(manager, ctx, auditActionsForJobType(row.jobType).sent, {
        targetUserId: row.targetUserId,
        metadata: { emailOutboxId: row.id, jobType: row.jobType },
        actorUserId: null, // background worker, no authenticated human — see AuditService.record's own doc comment
      });
    });
  };
}

async function revalidate(manager: EntityManager, row: EmailOutbox): Promise<{ ok: true } | { ok: false; reason: string }> {
  // `target_user_id`'s FK is `ON DELETE SET NULL` (never CASCADE — the
  // outbox row itself is meant to survive a deletion for audit purposes).
  // That means a row whose target user is deleted AFTER this row was
  // enqueued but BEFORE the worker claims it has its `targetUserId` nulled
  // out by the DB itself — checked here as `!row.targetUserId`, a hard
  // failure, not skipped. Every EmailOutboxJobType that exists today
  // always sets `targetUserId` at enqueue time (confirmed: ACCOUNT_
  // INVITATION/PASSWORD_RESET/PASSWORD_UPDATED/WELCOME/ACCOUNT_SUSPENDED/
  // NOTIFICATION all do), so a currently-null value is unambiguous
  // evidence of a since-deleted target, never a legitimate "no target"
  // email — `UserDeletionService.deleteUser()` already proactively cancels
  // open outbox rows before deleting a user, so this only fires for a
  // (currently nonexistent) deletion path that bypasses that service, but
  // per CLAUDE.md's fail-closed rule this worker-side check must not
  // depend on every future deletion path remembering to do that too. A
  // genuinely target-less email type, if one is ever added, must set this
  // check's expectations explicitly rather than silently falling through
  // a null check that was never meant to mean "no check needed."
  if (!row.targetUserId) return { ok: false, reason: 'Target user reference is missing (the account was deleted before delivery).' };
  const stillExists = await manager.query(`SELECT 1 FROM core."user" WHERE id = $1`, [row.targetUserId]);
  if (stillExists.length === 0) return { ok: false, reason: 'Target user no longer exists.' };

  if (row.accountInviteId) {
    const invite = await manager.findOne(AccountInvite, { where: { id: row.accountInviteId } });
    if (!invite) return { ok: false, reason: 'Invitation no longer exists.' };
    if (invite.revokedAt) return { ok: false, reason: 'Invitation was cancelled or superseded before delivery.' };
    if (invite.acceptedAt) return { ok: false, reason: 'Invitation was already accepted before delivery.' };
    // Still the user's CURRENT invite — a stale queued job for a
    // since-superseded row must never send even if nobody explicitly
    // revoked it (defense in depth alongside AccountInviteService.commit's
    // own proactive cancel).
    const latest = await manager.findOne(AccountInvite, { where: { userId: invite.userId }, order: { createdAt: 'DESC' } });
    if (latest && latest.id !== invite.id) return { ok: false, reason: 'A newer invitation now supersedes this one.' };
  }

  if (row.passwordResetTokenId) {
    const token = await manager.findOne(PasswordResetToken, { where: { id: row.passwordResetTokenId } });
    if (!token) return { ok: false, reason: 'Reset token no longer exists.' };
    if (token.usedAt) return { ok: false, reason: 'Reset token was already used or superseded before delivery.' };
    if (token.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'Reset token expired before delivery.' };
  }

  return { ok: true };
}

async function handleSendFailure(deps: EmailSendProcessorDeps, ctx: AuthContext, row: EmailOutbox, job: Job<EmailQueueJobData>, error: unknown): Promise<never> {
  const attemptsMade = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? row.maxInfrastructureAttempts;
  const retryable = isRetryable(error);
  const sanitized = sanitizeErrorMessage(error);
  const code = (error as { code?: string })?.code ?? (error as { name?: string })?.name ?? 'UNKNOWN';
  const isFinal = !retryable || attemptsMade >= maxAttempts;

  await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({
        status: isFinal ? EmailOutboxStatus.FAILED : EmailOutboxStatus.RETRY,
        infrastructureAttemptCount: attemptsMade,
        lastErrorCode: code,
        lastErrorMessageSanitized: sanitized,
        ...(isFinal ? { failedAt: () => 'now()' } : {}),
      })
      .where('id = :id', { id: row.id })
      .execute();

    if (isFinal) {
      await deps.auditService.record(manager, ctx, auditActionsForJobType(row.jobType).failed, {
        targetUserId: row.targetUserId,
        metadata: { emailOutboxId: row.id, jobType: row.jobType, errorCode: code, attempts: attemptsMade, retryable },
        actorUserId: null,
      });
    }
  });

  if (isFinal) {
    throw new UnrecoverableError(`Email delivery permanently failed for outbox row ${row.id}: ${code}`);
  }
  throw error;
}
