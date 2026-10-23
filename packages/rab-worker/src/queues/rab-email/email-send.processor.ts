import { randomUUID } from 'node:crypto';

import { EmailOutboxJobType, EmailOutboxStatus, ShiftStatus } from '@rab/shared';
import { Job, UnrecoverableError } from 'bullmq';
import { EntityManager } from 'typeorm';

import { AccountInvite, EmailOutbox, PasswordResetToken } from '@rab/server/modules/identity/entities/index';
import { ShiftReport } from '@rab/server/modules/attendance/entities/shift-report.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { AuditAction, AuditActionType, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { emailBodyCarriesSecret } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { FileKind } from '@rab/server/engine/core-modules/storage/file-kinds';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { StoredFile } from '@rab/server/engine/core-modules/storage/entities/stored-file.entity';
import { StorageError, StorageErrorCode } from '@rab/server/engine/core-modules/storage/storage.errors';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';

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
  // Storage failures know whether a retry could help: a timeout does, a checksum mismatch or missing object never does.
  if (error instanceof StorageError) return error.retryable;
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

/** `email-outbox:<id>` — the stable, per-logical-delivery identity. See `EmailSendOptions.idempotencyKey`'s doc comment. Never the BullMQ jobId. */
export function deliveryKeyFor(emailOutboxId: string): string {
  return `email-outbox:${emailOutboxId}`;
}

export interface EmailSendProcessorDeps {
  tenantContext: TenantContextService;
  emailService: EmailService;
  auditService: AuditService;
  /** Optional — only rows with `attachmentKey` set (the pre-shift/final Timesheet PDFs) need it; every other email job type sends without it. */
  fileService?: FileService;
}

/**
 * `ACCOUNT_INVITATION` keeps its own long-established action names (existing
 * tests assert `action === 'user.invited'` directly) — every other
 * `EmailOutboxJobType` (password reset/updated, welcome, suspension notice,
 * notification) resolves through the generic `EMAIL_SENT`/
 * `EMAIL_DELIVERY_FAILED` pair instead, with `metadata.jobType` disambiguating.
 */
/**
 * F1 (Wave 1 lane S): the columns to clear in the SAME write that makes a row terminal, when its body carries a bearer link
 * token (`emailBodyCarriesSecret`). Unsent rows (RETRY) keep their body so the next attempt can send it. The database
 * trigger `core.email_outbox_scrub_secret_body` enforces the same rule for every other writer; this is the service layer.
 */
function scrubSecretBody(row: EmailOutbox): { renderedHtml?: () => string; renderedText?: () => string } {
  return emailBodyCarriesSecret(row) ? { renderedHtml: () => 'NULL', renderedText: () => 'NULL' } : {};
}

function auditActionsForJobType(jobType: string): { sent: AuditActionType; failed: AuditActionType } {
  if (jobType === 'ACCOUNT_INVITATION') return { sent: AuditAction.INVITE_EMAIL_SENT, failed: AuditAction.INVITE_EMAIL_FAILED };
  return { sent: AuditAction.EMAIL_SENT, failed: AuditAction.EMAIL_DELIVERY_FAILED };
}

/**
 * The BullMQ processor — one call per delivery attempt (BullMQ itself
 * re-invokes this on each retry, per the queue's own `attempts`/`backoff`
 * config set in `EmailQueueService`). Binds real `crewflow` tenant context
 * via `organisationId` from the job payload (never owner/bypass access —
 * see `email-dispatch.job.ts`'s doc comment for why that's deliberately
 * confined to the dispatcher, not here).
 *
 * PHASE 9 — DELIVERY FENCING: every write this function makes from the point
 * it wins a claim onward is guarded by `processing_token`, a fresh UUID
 * minted at claim time. If a later write finds the token no longer matches
 * (another claim superseded ours — e.g. the dispatcher reclaimed our lease
 * while we were still, unknown to it, mid-flight), this function stops
 * WITHOUT writing SENT/RETRY/FAILED/CANCELLED or provider metadata — see
 * `runFenced`. This is what closes the "stale worker wakes up after lease
 * reclaim and overwrites a newer attempt's result" race.
 *
 * PROVIDER-CALL BOUNDARY: `provider_call_started_at` is persisted, fenced,
 * in its OWN committed step, strictly BEFORE `emailService.send()` is ever
 * called — this is the durable signal `email-dispatch.job.ts`'s recovery
 * sweep uses to tell "never reached the provider, safe to retry
 * unconditionally" apart from "the provider may already have been
 * contacted, consult the driver's ambiguous-retry safety first."
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
    const processingToken = randomUUID();

    const outcome = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await manager.findOne(EmailOutbox, { where: { id: emailOutboxId } });
      // Not visible (yet): a producer can fast-publish from INSIDE its still-open transaction (AccountLifecycleService), so this
      // worker may run before that commit. Completing here would strand the row as QUEUED until the dispatcher's 2-minute
      // stale-QUEUED recovery (BullMQ dedupes the same jobId), so throw instead: BullMQ retries with its 5 s backoff, by which
      // time the row is committed. A row that genuinely never appears just exhausts its attempts — nothing is sent either way.
      if (!row) throw new Error(`email outbox row ${emailOutboxId} is not visible yet — retrying`);

      if (row.status === EmailOutboxStatus.SENT) return { skip: true as const };
      if (row.status === EmailOutboxStatus.CANCELLED) return { skip: true as const };

      // Race-safe claim: only one worker (or one retry-in-flight) can move
      // a row into PROCESSING at a time, and it mints the ONE token every
      // subsequent write for this attempt must present.
      const claim = await manager
        .createQueryBuilder()
        .update(EmailOutbox)
        .set({ status: EmailOutboxStatus.PROCESSING, processingAt: () => 'now()', processingToken })
        .where('id = :id AND status IN (:...open)', { id: row.id, open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.RETRY] })
        .execute();
      if (!claim.affected) return { skip: true as const };

      const revalidation = await revalidate(manager, row);
      if (!revalidation.ok) {
        await manager
          .createQueryBuilder()
          .update(EmailOutbox)
          .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()', lastErrorMessageSanitized: revalidation.reason, ...scrubSecretBody(row) })
          .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: EmailOutboxStatus.PROCESSING, token: processingToken })
          .execute();
        return { skip: true as const };
      }

      // Durable, committed BEFORE the provider is ever contacted — the fact
      // this write happened is itself the signal recovery needs; its own
      // fencing means it silently no-ops (not an error) if we already lost
      // the claim between the two statements above and here.
      await manager
        .createQueryBuilder()
        .update(EmailOutbox)
        .set({ providerCallStartedAt: () => 'now()' })
        .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: EmailOutboxStatus.PROCESSING, token: processingToken })
        .execute();

      return { skip: false as const, row };
    });

    if (outcome.skip) return;
    const row = outcome.row!;

    try {
      // Fail closed: never deliver an email with no body (e.g. a row whose body was already cleared). Not retryable — a
      // retry would find the same empty row — so this ends FAILED through handleSendFailure, like any permanent error.
      if (!row.renderedHtml && !row.renderedText) {
        throw Object.assign(new Error('The outbox row has no rendered body; refusing to send an empty email.'), { code: 'EMPTY_BODY' });
      }
      let attachments: { filename: string; content: Buffer; contentType?: string }[] | undefined;
      if (row.attachmentFileId || row.attachmentKey) {
        if (!deps.fileService) throw new Error('This job requires an attachment but no FileService was provided to the processor.');
        if (!row.attachmentFileId) {
          // A pre-migration row that still carries a raw key. Never trust a key from a queue/outbox row: fail closed.
          throw new StorageError(StorageErrorCode.PERMISSION_ERROR, 'Legacy attachment key rows must be migrated to file ids before sending.', false);
        }
        // Context comes from the trusted outbox ROW (never the queue payload): org + the workspace the file belongs to.
        const fileCtx: AuthContext = { organisationId: row.organisationId, workspaceId: row.workspaceId ?? null, userId: '', role: '' };
        const file = await deps.tenantContext.runInTenantContext(fileCtx, (manager) => deps.fileService!.findAvailable(manager, row.attachmentFileId!));
        if (!file) throw new StorageError(StorageErrorCode.OBJECT_NOT_FOUND, 'The attachment file record is missing or not available.', false);
        // Only generated report evidence may ride on an email: belt-and-braces beyond RLS.
        if (file.kind !== FileKind.SHIFT_ROSTER_PDF && file.kind !== FileKind.FINAL_TIMESHEET_PDF) {
          throw new StorageError(StorageErrorCode.PERMISSION_ERROR, 'This file kind cannot be emailed.', false);
        }
        // Bytes come from the shared object store and are verified against the SHA-256 recorded when the file was
        // generated (possibly by a different worker). A mismatch is never sent.
        const content = await deps.fileService.readVerified(file);
        attachments = [{ filename: row.attachmentFilename ?? file.originalFilename, content, contentType: file.mimeType }];
      }
      const result = await deps.emailService.send({
        to: row.recipientEmail,
        subject: row.renderedSubject,
        html: row.renderedHtml ?? undefined,
        text: row.renderedText ?? undefined,
        attachments,
        idempotencyKey: deliveryKeyFor(row.id),
      });
      await persistSent(deps, ctx, row, job, processingToken, result);
    } catch (error) {
      // Always throws — either the original error (BullMQ retries per its
      // own attempts/backoff config) or UnrecoverableError (BullMQ stops
      // immediately) — after persisting RETRY/FAILED state, UNLESS this
      // worker already lost the fencing token, in which case it does
      // neither (see handleSendFailure's own doc comment).
      await handleSendFailure(deps, ctx, row, job, processingToken, error);
    }
  };
}

/**
 * Persists SENT with a small bounded LOCAL retry — for a transient DB blip
 * on the write itself, never for a provider failure (the provider was
 * already, definitively, successfully called by the time this runs; calling
 * it again here would be exactly the duplicate-send risk this phase exists
 * to remove). If every local retry is exhausted by a genuine error (not a
 * lost fencing token — that case is handled inline, no retry needed, no
 * error), this fails LOUDLY: logged in full and rethrown, never swallowed.
 * The row is left PROCESSING under a token this same worker still holds;
 * `email-dispatch.job.ts`'s stale-lease recovery — which by then sees
 * `provider_call_started_at` set — is the backstop that resolves the
 * ambiguity this leaves behind, per the driver's own ambiguous-retry safety.
 */
async function persistSent(
  deps: EmailSendProcessorDeps,
  ctx: AuthContext,
  row: EmailOutbox,
  job: Job<EmailQueueJobData>,
  processingToken: string,
  result: { provider: string; providerMessageId?: string },
): Promise<void> {
  const attempts = [0, 100, 400]; // 3 tries, short backoff — a blip, not an outage
  let lastError: unknown;
  for (const delayMs of attempts) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
        const write = await manager
          .createQueryBuilder()
          .update(EmailOutbox)
          .set({
            status: EmailOutboxStatus.SENT,
            sentAt: () => 'now()',
            infrastructureAttemptCount: job.attemptsMade + 1,
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            ...scrubSecretBody(row),
          })
          .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: EmailOutboxStatus.PROCESSING, token: processingToken })
          .execute();
        if (!write.affected) {
          // Lost the fencing token — someone else's claim (a reclaim we didn't know about) now owns this row.
          // The provider send already happened for real; there is nothing left for THIS attempt to correctly do.
          // eslint-disable-next-line no-console
          console.warn(`email send: lost processing_token for outbox row ${row.id} after a successful provider send — another claim now owns it, not writing SENT.`);
          return;
        }
        await deps.auditService.record(manager, ctx, auditActionsForJobType(row.jobType).sent, {
          targetUserId: row.targetUserId,
          metadata: { emailOutboxId: row.id, jobType: row.jobType, provider: result.provider },
          actorUserId: null, // background worker, no authenticated human — see AuditService.record's own doc comment
        });
      });
      return; // success (or a lost-token no-op, which is also a correct terminal outcome for this attempt)
    } catch (error) {
      lastError = error;
    }
  }
  // eslint-disable-next-line no-console
  console.error(
    `email send: PROVIDER SUCCEEDED (provider=${result.provider}${result.providerMessageId ? `, messageId=${result.providerMessageId}` : ''}) but persisting SENT for outbox row ${row.id} failed after ${attempts.length} local attempts. The row remains PROCESSING; recovery will resolve it as an ambiguous delivery.`,
    lastError,
  );
  throw lastError;
}

async function revalidate(manager: EntityManager, row: EmailOutbox): Promise<{ ok: true } | { ok: false; reason: string }> {
  // The ONE job type that legitimately has no target user at enqueue time (the invitee has no account yet).
  // It is routed to its own, stricter revalidation BEFORE the missing-target-user safeguard below — that
  // safeguard is untouched and still applies to every other job type, so a deleted account's email can never
  // slip through by having its type mislabelled: a MEMBER_INVITATION row without a live invitation link is
  // cancelled too (and the schema's CHECK makes such a row unrepresentable in the first place).
  if (row.jobType === EmailOutboxJobType.MEMBER_INVITATION) return revalidateMemberInvitation(manager, row);
  if (row.jobType === EmailOutboxJobType.ORGANISATION_INVITATION) return revalidateOrganisationInvitation(manager, row);

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

  // PHASE 5 (§14) — the pre-shift roster+QR email is only ever correct while
  // the shift it describes is still active; a shift cancelled in the window
  // between `shift-report-scheduler.job.ts` enqueueing this row (itself
  // already re-checked at enqueue time — see that job's own
  // `reportNeedsGeneration`) and this worker actually sending it must not
  // still go out claiming an active roster. Uses the SAME structured
  // linkage the file itself already carries (`stored_file.resource_type =
  // 'shift_report'`, `resource_id` = the `ShiftReport` row's own id) rather
  // than any message-text parsing — no new column needed. Deliberately
  // narrower than "every attachment": the final Timesheet PDF
  // (`FileKind.FINAL_TIMESHEET_PDF`) is historical truth by the time it's
  // ever generated (only reachable once a manager has explicitly finalised
  // the report — see that job's own doc comment) and must keep sending
  // regardless of the shift's later cancellation, never suppressed here.
  //
  // `StoredFile` is workspace-forced RLS, but this whole function runs
  // under the OUTER `ctx` (`workspaceId: null` — see `processEmailSendJob`'s
  // own doc comment on why: an ordinary `EmailOutbox` row isn't itself
  // workspace-scoped). Reading a workspace-scoped row therefore needs its
  // OWN nested context bound to `row.workspaceId`, mirroring the identical
  // pattern the attachment-read step below already uses for the same reason
  // — never the outer, deliberately-workspace-less ctx, which would make
  // `StoredFile`'s RLS silently return nothing and this check a no-op.
  if (row.attachmentFileId) {
    // Same transaction, same connection: bind the row's workspace for this check only, then restore the outer (workspace-less) binding.
    // A nested runInTenantContext here would acquire a SECOND pooled connection while the claim transaction still holds the first, which
    // starves a small pool. On failure the outer transaction rolls back, so no restore is needed on that path.
    await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [row.workspaceId ?? '']);
    const file = await manager.findOne(StoredFile, { where: { id: row.attachmentFileId } });
    let invalidReason: string | null = null;
    if (file?.kind === FileKind.SHIFT_ROSTER_PDF && file.resourceType === 'shift_report') {
      const report = await manager.findOne(ShiftReport, { where: { id: file.resourceId } });
      const shift = report ? await manager.findOne(Shift, { where: { id: report.shiftId } }) : null;
      if (!shift || shift.status === ShiftStatus.CANCELLED) {
        invalidReason = 'The shift this roster is for has been cancelled since it was queued.';
      }
    }
    await manager.query(`SELECT set_config('rab.workspace_id', '', true)`);
    if (invalidReason) return { ok: false, reason: invalidReason };
  }

  return { ok: true };
}

/**
 * Pre-delivery revalidation for email-first member invitations. The email may only go out while ALL of these
 * still hold at the moment of sending (not merely at enqueue time):
 *  - the outbox row is linked to an invitation that still exists in this organisation and the SAME workspace the
 *    row was enqueued for;
 *  - the invitation is not accepted, revoked or superseded, and has not expired;
 *  - this outbox row is that invitation's LATEST email — a resend rotates the token and enqueues a new row, so an
 *    older queued email (carrying a dead link) must never be delivered;
 *  - the organisation is not suspended.
 * `member_invitation`'s RLS policy is organisation AND workspace scoped, while this processor's outer context is
 * deliberately workspace-less — so the row's own (trusted, server-written) workspace is bound for this check only,
 * then cleared, on the same connection (same pattern and reasoning as the roster-attachment check above).
 */
async function revalidateMemberInvitation(manager: EntityManager, row: EmailOutbox): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!row.memberInvitationId) return { ok: false, reason: 'Invitation reference is missing.' };
  await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [row.workspaceId ?? '']);
  let reason: string | null = null;
  const [invitation] = await manager.query<Array<{ accepted_at: Date | null; revoked_at: Date | null; superseded_at: Date | null; expired: boolean; workspace_id: string | null }>>(
    `SELECT accepted_at, revoked_at, superseded_at, (expires_at <= now()) AS expired, workspace_id FROM core.member_invitation WHERE id = $1`,
    [row.memberInvitationId],
  );
  if (!invitation) reason = 'Invitation no longer exists.';
  else if ((invitation.workspace_id ?? null) !== (row.workspaceId ?? null)) reason = 'Invitation scope does not match this email.';
  else if (invitation.accepted_at) reason = 'Invitation was already accepted before delivery.';
  else if (invitation.revoked_at) reason = 'Invitation was revoked before delivery.';
  else if (invitation.superseded_at) reason = 'Invitation was superseded before delivery.';
  else if (invitation.expired) reason = 'Invitation expired before delivery.';
  else {
    const [latest] = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [row.memberInvitationId],
    );
    if (latest && latest.id !== row.id) reason = 'A newer invitation email supersedes this one.';
    const [org] = await manager.query<Array<{ suspended_at: Date | null }>>(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [row.organisationId]);
    if (!reason && (!org || org.suspended_at)) reason = 'The organisation is suspended.';
  }
  await manager.query(`SELECT set_config('rab.workspace_id', '', true)`);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * Pre-delivery revalidation for a platform administrator's CEO (organisation) invitation — the second job type with no
 * target user at enqueue time (no organisation or account exists until the CEO accepts). The email may only go out
 * while the invitation is still LIVE (`core.organisation_invitation_state`: not accepted, revoked, superseded or
 * expired), this outbox row is the invitation's latest send (a resend rotates the token, so an older queued email
 * carries a dead link), and the sending organisation is not suspended.
 */
async function revalidateOrganisationInvitation(manager: EntityManager, row: EmailOutbox): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!row.organisationInvitationId) return { ok: false, reason: 'Invitation reference is missing.' };
  const [{ state }] = await manager.query<Array<{ state: string }>>(`SELECT core.organisation_invitation_state($1) AS state`, [row.organisationInvitationId]);
  if (state !== 'live') return { ok: false, reason: `Invitation is ${state} (no longer deliverable).` };
  const [latest] = await manager.query<Array<{ id: string }>>(
    `SELECT id FROM core.email_outbox WHERE organisation_invitation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [row.organisationInvitationId],
  );
  if (latest && latest.id !== row.id) return { ok: false, reason: 'A newer invitation email supersedes this one.' };
  const [org] = await manager.query<Array<{ suspended_at: Date | null }>>(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [row.organisationId]);
  if (!org || org.suspended_at) return { ok: false, reason: 'The organisation is suspended.' };
  return { ok: true };
}

/**
 * Persists RETRY/FAILED and rethrows — UNLESS this worker's fencing token no
 * longer matches (another claim already superseded ours), in which case it
 * writes nothing and returns normally: per Phase 9 §9, a stale worker must
 * never be able to mark RETRY/FAILED (or anything else) once its lease has
 * been reclaimed, and there is nothing useful left for it to signal BullMQ
 * about — the row's fate now belongs to whoever holds the current token.
 */
async function handleSendFailure(deps: EmailSendProcessorDeps, ctx: AuthContext, row: EmailOutbox, job: Job<EmailQueueJobData>, processingToken: string, error: unknown): Promise<void> {
  const attemptsMade = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? row.maxInfrastructureAttempts;
  const retryable = isRetryable(error);
  const sanitized = sanitizeErrorMessage(error);
  const code = (error as { code?: string })?.code ?? (error as { name?: string })?.name ?? 'UNKNOWN';
  const isFinal = !retryable || attemptsMade >= maxAttempts;

  const wroteAsOwner = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
    const write = await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({
        status: isFinal ? EmailOutboxStatus.FAILED : EmailOutboxStatus.RETRY,
        infrastructureAttemptCount: attemptsMade,
        lastErrorCode: code,
        lastErrorMessageSanitized: sanitized,
        ...(isFinal ? { failedAt: () => 'now()', ...scrubSecretBody(row) } : {}),
      })
      .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: EmailOutboxStatus.PROCESSING, token: processingToken })
      .execute();
    if (!write.affected) return false;

    if (isFinal && error instanceof StorageError && (error.code === StorageErrorCode.INTEGRITY_FAILED || error.code === StorageErrorCode.OBJECT_NOT_FOUND)) {
      await deps.auditService.record(manager, ctx, AuditAction.REPORT_INTEGRITY_FAILED, {
        entityType: 'email_outbox',
        entityId: row.id,
        metadata: { code: error.code, fileId: row.attachmentFileId ?? null },
        actorUserId: null,
      });
    }
    if (isFinal) {
      await deps.auditService.record(manager, ctx, auditActionsForJobType(row.jobType).failed, {
        targetUserId: row.targetUserId,
        metadata: { emailOutboxId: row.id, jobType: row.jobType, errorCode: code, attempts: attemptsMade, retryable },
        actorUserId: null,
      });
    }
    return true;
  });

  if (!wroteAsOwner) {
    // eslint-disable-next-line no-console
    console.warn(`email send: lost processing_token for outbox row ${row.id} while handling a send failure — another claim now owns it, not writing ${isFinal ? 'FAILED' : 'RETRY'}.`);
    return;
  }

  if (isFinal) {
    throw new UnrecoverableError(`Email delivery permanently failed for outbox row ${row.id}: ${code}`);
  }
  throw error;
}
