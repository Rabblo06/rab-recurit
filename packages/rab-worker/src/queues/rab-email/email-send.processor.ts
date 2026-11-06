import { randomUUID } from 'node:crypto';

import { EmailOutboxJobType, EmailOutboxStatus, ShiftStatus } from '@rab/shared';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
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
import { WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { PermissionsService } from '@rab/server/engine/core-modules/permissions/permissions.service';
import {
  checkReportRecipient,
  REPORT_EMAIL_REASON_ORGANISATION_SUSPENDED,
  REPORT_RECIPIENT_INELIGIBLE,
  ReportPermissionChecker,
} from '../rab-reports/report-recipients';
import { ClaimedAttempt, claimedAttemptFrom } from '../claimed-attempt';

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * D5 (D0-C §4.6) — retry classification, from what the error itself says (nodemailer 10: `code`, `responseCode`,
 * `permanent`; Resend: EmailProviderError's own `retryable`/`retryAfterMs`; StorageError: its own `retryable`):
 *  - SMTP 5xx reply (RFC 5321 permanent negative completion; nodemailer sets `permanent`), except 503 → PERMANENT;
 *  - SMTP 4xx reply (421 service unavailable, 450/451/452 try later — incl. provider throttling) and 503 → RETRYABLE;
 *  - network / timeout / connection codes → RETRYABLE;
 *  - local configuration or validation failures nodemailer reports with NO server reply (bad address, missing
 *    credentials, message too large, REQUIRETLS unsupported) and EMPTY_BODY → PERMANENT;
 *  - anything unrecognised → RETRYABLE (fail safe toward "try again", never toward silently giving up).
 * The old rules were inverted: they RETRIED every `responseCode >= 500` and any message containing a 5xx number, and
 * treated a 4xx with no matching text and every unknown error as permanent.
 * `false` short-circuits to FAILED via `UnrecoverableError` regardless of how many attempts remain.
 */
const PERMANENT_CODES = new Set(['EMPTY_BODY', 'ECONFIG', 'ENOAUTH', 'EMAXRECIPIENTS', 'EREQUIRETLS', 'EFILEACCESS', 'EURLACCESS']);
/** nodemailer validates these locally (command 'API', no server reply): retrying sends the same invalid input. */
const LOCAL_VALIDATION_CODES = new Set(['EENVELOPE', 'EAUTH', 'EMESSAGE']);

export interface EmailSendErrorClass {
  retryable: boolean;
  /** Provider-reported throttling (e.g. Resend 429 `retry-after`), in ms. */
  retryAfterMs?: number;
}

export function classifyEmailSendError(error: unknown): EmailSendErrorClass {
  // Storage failures know whether a retry could help: a timeout does, a checksum mismatch or missing object never does.
  if (error instanceof StorageError) return { retryable: error.retryable };
  // Fail closed, unchanged: a report email whose workspace cannot be routed ends FAILED (nothing sent), never retried.
  if (error instanceof WorkspaceRoutingError) return { retryable: false };
  const err = (error ?? {}) as { code?: unknown; responseCode?: unknown; permanent?: unknown; retryable?: unknown; retryAfterMs?: unknown };
  const code = typeof err.code === 'string' ? err.code : undefined;
  if (code && PERMANENT_CODES.has(code)) return { retryable: false };
  // A provider driver that classified its own failure (ResendDriver → EmailProviderError).
  if (typeof err.retryable === 'boolean') {
    const retryAfterMs = typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : undefined;
    return retryAfterMs === undefined ? { retryable: err.retryable } : { retryable: err.retryable, retryAfterMs };
  }
  if (typeof err.responseCode === 'number') {
    if (err.responseCode >= 500 && err.responseCode < 600) return { retryable: err.responseCode === 503 };
    if (err.responseCode >= 400 && err.responseCode < 500) return { retryable: true };
  }
  if (err.permanent === true) return { retryable: false };
  if (code && LOCAL_VALIDATION_CODES.has(code) && typeof err.responseCode !== 'number') return { retryable: false };
  return { retryable: true };
}

/** Bounds for honouring a provider's Retry-After: at least 1 s, at most 2 minutes (the stale-RETRY recovery is 5 min). */
const THROTTLE_MIN_MS = 1_000;
const THROTTLE_MAX_MS = 120_000;
/** A throttled job may be re-delayed (without consuming an attempt) only while it has been started fewer times than this. */
const THROTTLE_MAX_STARTS = 10;

/** The delay to honour for a retryable, provider-throttled failure, or null (normal jittered backoff). */
export function throttleDelayMs(verdict: EmailSendErrorClass): number | null {
  if (!verdict.retryable || verdict.retryAfterMs === undefined) return null;
  return Math.min(THROTTLE_MAX_MS, Math.max(THROTTLE_MIN_MS, Math.round(verdict.retryAfterMs)));
}

export function sanitizeErrorMessage(error: unknown, recipient?: string | null): string {
  // Bounded BEFORE the regexes (independent review L2): a provider error can be arbitrarily large, and redaction is linear
  // but not free. 4x the stored length keeps every address that could survive the final cut.
  const message = String((error as { message?: string })?.message ?? error).slice(0, MAX_ERROR_MESSAGE_LENGTH * 4);
  // email-twenty (owner requirement 3): an SMTP reply usually echoes the mailbox it refused ("550 5.1.1 <a@b.test>: User
  // unknown"), and nodemailer appends that reply to its error message. This text reaches the outbox row, the Worker log
  // (the consumer's `failed` listener) and Redis (BullMQ's failedReason), so the row's own recipient is removed first,
  // exactly, in whatever form the server echoes it (quoted local parts included — review L1).
  const withoutRecipient = recipient ? replaceAllCaseInsensitive(message, recipient, '[address]') : message;
  // Defense-in-depth, not the primary control — nothing in this codebase's
  // email path ever puts a password/API key into an Error message (verified
  // by reading every driver), but a future driver change is exactly the
  // kind of regression this guards against without needing to trust that
  // discipline holds forever. The keyword, an optional separator and auth scheme, then the value (review L3:
  // "Authorization: Bearer x" used to keep "Bearer x").
  const scrubbed = withoutRecipient.replace(/(password|pass|apikey|api_key|authorization|token|secret)\s{0,4}[:=]?\s{0,4}(?:(?:bearer|basic)\s{1,4})?[^\s,;]{0,200}/gi, '[redacted]');
  return redactEmailAddresses(scrubbed).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/** Every whitespace/`<>`-delimited token that contains an `@` becomes `[address]` (bounded quantifiers: linear). */
export function redactEmailAddresses(text: string): string {
  return text.replace(/[^\s<>]{0,320}@[^\s<>]{0,320}/g, '[address]');
}

/** Literal (not regex) replacement, ignoring ASCII case — mailbox addresses compare case-insensitively in practice. */
function replaceAllCaseInsensitive(text: string, needle: string, replacement: string): string {
  if (!needle) return text;
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  if (haystack.length !== text.length || target.length !== needle.length) return text.split(needle).join(replacement);
  let out = '';
  let from = 0;
  for (let at = haystack.indexOf(target); at !== -1; at = haystack.indexOf(target, from)) {
    out += text.slice(from, at) + replacement;
    from = at + target.length;
  }
  return out + text.slice(from);
}

/**
 * email-twenty (owner requirements 3 and 4): what a RETRYABLE failed attempt throws to BullMQ, instead of the provider's own
 * error. Twenty rethrows the nodemailer error itself (and logs the recipient); here BullMQ only ever sees the sanitized
 * message (addresses and keyword-labelled credentials redacted), the error code and the SMTP reply code, so its retry/backoff still
 * applies and its failedReason, the Worker log and the job's stacktrace in Redis carry nothing personal.
 */
export class EmailSendAttemptError extends Error {
  constructor(
    emailOutboxId: string,
    readonly code: string,
    readonly responseCode: number | undefined,
    sanitizedMessage: string,
  ) {
    super(`Email delivery attempt failed for outbox row ${emailOutboxId} (${code}${responseCode ? ` ${responseCode}` : ''}), will retry: ${sanitizedMessage}`);
    this.name = 'EmailSendAttemptError';
  }
}

/** `email-outbox:<id>` — the stable, per-logical-delivery identity. See `EmailSendOptions.idempotencyKey`'s doc comment. Never the BullMQ jobId. */
export function deliveryKeyFor(emailOutboxId: string): string {
  return `email-outbox:${emailOutboxId}`;
}

/** Minutes after which the dispatcher reclaims a PROCESSING row (`email-dispatch.job.ts` PROCESSING_LEASE_MINUTES). Log text only. */
const LEASE_MINUTES_FOR_LOG = 10;

/**
 * D-Q5b, OD-5 Option B (owner approval 2026-11-04): the provider CONFIRMED the send and only persisting SENT failed. Never
 * routed to handleSendFailure: a RETRY write there made BullMQ call the provider a second time (a duplicate email, audit
 * §13 #3). The processor ends the job instead (UnrecoverableError) and leaves the row to lease recovery.
 */
export class SentWriteFailedError extends Error {
  readonly code = 'PERSIST_SENT_FAILED';
  constructor(
    emailOutboxId: string,
    readonly persistError: unknown,
  ) {
    super(`Email outbox row ${emailOutboxId}: the provider accepted the email but SENT could not be persisted; left PROCESSING for lease recovery (no resend).`);
    this.name = 'SentWriteFailedError';
  }
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
 *
 * D-Q5b: the claim counts the attempt (`infrastructure_attempt_count + 1`, cumulative across generations — see
 * `claimed-attempt.ts`) and refuses a row already at `max_infrastructure_attempts`; a failed SENT write after a confirmed
 * send is never retried by BullMQ and never written RETRY (see `SentWriteFailedError`). This is not exactly-once: lease
 * recovery re-presents a Resend row once under the same idempotency key, which the provider deduplicates only inside its
 * key window (24 h; the lease is 10 min) — a recovery delayed past that window could send a second email. SMTP rows go to
 * DELIVERY_UNCERTAIN (manual review) instead.
 */
export function createEmailSendProcessor(deps: EmailSendProcessorDeps) {
  return async function processEmailSendJob(job: Job<EmailQueueJobData>): Promise<void> {
    const { emailOutboxId, organisationId } = job.data;
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: '', role: '' };
    const processingToken = randomUUID();

    const outcome = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await manager.findOne(EmailOutbox, { where: { id: emailOutboxId } });
      // Not visible (yet): the safety net. Producers fast-publish only after their transaction commits
      // (EmailOutboxService.publishAfterCommit, or tryFastPublish called after the transaction), but any producer that
      // publishes before its commit, now or in future, lets this worker run first. Completing here would strand the row
      // as QUEUED until the dispatcher's 2-minute stale-QUEUED recovery (BullMQ dedupes the same jobId), so throw instead:
      // BullMQ retries with its 5 s backoff, by which time the row is committed. This throw comes before the claim, so it
      // never counts toward the row's cumulative attempt cap. A row that genuinely never appears (its transaction rolled
      // back) just exhausts its attempts — nothing is sent either way.
      if (!row) throw new Error(`email outbox row ${emailOutboxId} is not visible yet — retrying`);

      if (row.status === EmailOutboxStatus.SENT) return { skip: true as const };
      if (row.status === EmailOutboxStatus.CANCELLED) return { skip: true as const };

      // Race-safe claim: only one worker (or one retry-in-flight) can move
      // a row into PROCESSING at a time, and it mints the ONE token every
      // subsequent write for this attempt must present.
      // D-Q5b (OC-1): the same CAS counts this attempt and returns the cumulative count; a row already at its cap is not
      // claimed (nothing is sent; the dispatcher's exhausted gate fails it).
      const claim = await manager
        .createQueryBuilder()
        .update(EmailOutbox)
        .set({
          status: EmailOutboxStatus.PROCESSING,
          processingAt: () => 'now()',
          processingToken,
          infrastructureAttemptCount: () => 'infrastructure_attempt_count + 1',
          // The marker describes THIS attempt only (review I1): a marker left by an earlier attempt that ended RETRY must
          // not make a crash before this attempt's own marker look like "the provider may have it" (DELIVERY_UNCERTAIN).
          // It is written again, fenced, immediately before this attempt's provider call.
          providerCallStartedAt: null,
        })
        .where('id = :id AND status IN (:...open) AND infrastructure_attempt_count < max_infrastructure_attempts', {
          id: row.id,
          open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.RETRY],
        })
        .returning(['infrastructureAttemptCount', 'maxInfrastructureAttempts'])
        .execute();
      if (!claim.affected) return { skip: true as const };
      const attempt = claimedAttemptFrom(claim.raw, 'infrastructure_attempt_count', 'max_infrastructure_attempts');
      return { skip: false as const, row, attempt };
    });

    if (outcome.skip) return;
    const row = outcome.row!;
    const attempt = outcome.attempt!;

    try {
      // Revalidation runs in its OWN transaction, after the counted claim committed (email-twenty, owner requirement 11).
      // It used to share the claim's transaction, so an error thrown here (a database fault in a revalidation query)
      // rolled the claim back with its attempt count: BullMQ retried, the dispatcher republished the still-QUEUED row, and
      // the cycle repeated for ever without ever reaching the cap or FAILED. Now such an error reaches handleSendFailure
      // like any other failed attempt: RETRY with the counted attempt, FAILED at the cap. The row is PROCESSING under our
      // token with no provider-call marker until the marker write below, so a crash in between is a plain safe retry
      // (lease recovery republishes it; nothing could have been sent).
      const prepared = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
        const revalidation = await revalidate(manager, row);
        if (!revalidation.ok) {
          await cancelClaimedRow(manager, row, processingToken, revalidation);
          return 'stop' as const;
        }
        // A row with an attachment (a report PDF) is revalidated once more against its WORKSPACE's own tables before the
        // provider-call marker is written — see the attachment step below.
        if (row.attachmentFileId) return 'attachment' as const;
        // Durable, committed BEFORE the provider is ever contacted — the fact this write happened is itself the signal
        // recovery needs. Fenced: 0 rows means another claim owns the row now, so this attempt sends nothing.
        return (await markProviderCallStarted(manager, row, processingToken)) > 0 ? ('send' as const) : ('stop' as const);
      });
      if (prepared === 'stop') return;
      if (prepared === 'attachment') {
        // Report emails (roster + Shift QR, final timesheet). Their shift, report and venue assignment live in the
        // WORKSPACE's tables (the physical workspace schema under HWS, `core` otherwise), so they are re-read under the
        // row's own trusted workspace via runInWorkspaceContext — which resolves and binds that schema and fails closed
        // (throws: the attempt ends RETRY/FAILED through handleSendFailure, never a send) when it cannot. Its own short
        // transaction, AFTER the claim committed: never a second pooled connection while the claim is still open. The row
        // is PROCESSING under our token with no provider-call marker yet, so a crash here is a plain safe retry.
        const verdict = await deps.tenantContext.runInWorkspaceContext(
          { organisationId: row.organisationId, workspaceId: row.workspaceId ?? null, userId: '', role: '' },
          (manager) => revalidateAttachment(manager, row, new PermissionsService(deps.tenantContext)),
        );
        const proceed = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
          if (!verdict.ok) {
            const cancelled = await cancelClaimedRow(manager, row, processingToken, verdict);
            // S-6: a report email cancelled for its recipient is AUDITED, in the same transaction as the CANCELLED write
            // (only when this attempt still owned the row). Ids, job type and a reason code only. CANCELLED is terminal:
            // the row is never replayed (outbox replay only ever acts on FAILED rows), and the report/PDF are untouched.
            if (cancelled > 0 && verdict.code) {
              await deps.auditService.record(manager, ctx, AuditAction.REPORT_EMAIL_CANCELLED, {
                entityType: 'email_outbox',
                entityId: row.id,
                targetUserId: row.targetUserId ?? undefined,
                metadata: {
                  emailOutboxId: row.id,
                  fileId: row.attachmentFileId ?? null,
                  jobType: row.jobType,
                  reasonCode: verdict.auditReasonCode ?? verdict.code,
                },
                actorUserId: null, // background worker, no authenticated human
              });
            }
            return false;
          }
          // Lost the fencing token in between: another claim owns the row now, so this attempt sends nothing.
          return (await markProviderCallStarted(manager, row, processingToken)) > 0;
        });
        if (!proceed) return;
      }
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
      await persistSent(deps, ctx, row, attempt, processingToken, result);
    } catch (error) {
      // D-Q5b, OD-5 Option B: the provider already accepted this email; only SENT could not be written. No RETRY/FAILED write
      // (RETRY made BullMQ send it again) — the row stays PROCESSING under this token with its provider-call marker, and
      // UnrecoverableError stops BullMQ from re-running the job. Lease recovery resolves the row without a second email.
      if (error instanceof SentWriteFailedError) throw new UnrecoverableError(error.message);
      // Always throws — either a sanitized EmailSendAttemptError (BullMQ retries per its
      // own attempts/backoff config) or UnrecoverableError (BullMQ stops
      // immediately) — after persisting RETRY/FAILED state, UNLESS this
      // worker already lost the fencing token, in which case it does
      // neither (see handleSendFailure's own doc comment).
      await handleSendFailure(deps, ctx, row, job, processingToken, attempt, error);
    }
  };
}

/**
 * The existing CANCELLED write, fenced by this attempt's token. A `code` (report emails) is also logged — ids only, never
 * the address. Returns the number of rows written (0 = this attempt no longer owns the row).
 */
async function cancelClaimedRow(manager: EntityManager, row: EmailOutbox, processingToken: string, verdict: { reason: string; code?: string }): Promise<number> {
  const write = await manager
    .createQueryBuilder()
    .update(EmailOutbox)
    .set({
      status: EmailOutboxStatus.CANCELLED,
      cancelledAt: () => 'now()',
      lastErrorMessageSanitized: verdict.reason,
      ...(verdict.code ? { lastErrorCode: verdict.code } : {}),
      ...scrubSecretBody(row),
    })
    .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: EmailOutboxStatus.PROCESSING, token: processingToken })
    .execute();
  // eslint-disable-next-line no-console
  if (verdict.code) console.warn(`email send: outbox row ${row.id} cancelled before delivery (${verdict.code}).`);
  return write.affected ?? 0;
}

/** `provider_call_started_at`, fenced by this attempt's token. Returns the number of rows written (0 = token lost). */
async function markProviderCallStarted(manager: EntityManager, row: EmailOutbox, processingToken: string): Promise<number> {
  const write = await manager
    .createQueryBuilder()
    .update(EmailOutbox)
    .set({ providerCallStartedAt: () => 'now()' })
    .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: EmailOutboxStatus.PROCESSING, token: processingToken })
    .execute();
  return write.affected ?? 0;
}

/**
 * Persists SENT with a small bounded LOCAL retry — for a transient DB blip
 * on the write itself, never for a provider failure (the provider was
 * already, definitively, successfully called by the time this runs; calling
 * it again here would be exactly the duplicate-send risk this phase exists
 * to remove). If every local retry is exhausted by a genuine error (not a
 * lost fencing token — that case is handled inline, no retry needed, no
 * error), this fails LOUDLY: logged in full and thrown as
 * `SentWriteFailedError`, never swallowed. The row is left PROCESSING under a
 * token this same worker still holds, and the processor ends the job without
 * a RETRY write (D-Q5b, OD-5 Option B — before, the error reached
 * handleSendFailure, which wrote RETRY, and BullMQ sent the email again).
 * `email-dispatch.job.ts`'s stale-lease recovery — which by then sees
 * `provider_call_started_at` set — is the backstop that resolves the
 * ambiguity this leaves behind, per the driver's own ambiguous-retry safety:
 * SMTP → FAILED `DELIVERY_UNCERTAIN` (manual review); Resend → one
 * re-presentation under the same idempotency key (deduplicated by Resend); a
 * row at its attempt cap → `DELIVERY_UNCERTAIN` for every driver.
 */
async function persistSent(
  deps: EmailSendProcessorDeps,
  ctx: AuthContext,
  row: EmailOutbox,
  attempt: ClaimedAttempt,
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
            infrastructureAttemptCount: attempt.count,
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
    `email send: PROVIDER SUCCEEDED (provider=${result.provider}${result.providerMessageId ? `, messageId=${result.providerMessageId}` : ''}) but persisting SENT for outbox row ${row.id} failed after ${attempts.length} local attempts. ` +
      `The row is left PROCESSING with its provider-call marker and this job is not retried (no second send). After the ${LEASE_MINUTES_FOR_LOG}-minute lease, ` +
      'recovery resolves it per driver: SMTP → FAILED DELIVERY_UNCERTAIN (manual review); Resend → one re-presentation under the same idempotency key (the provider returns the original message); at the attempt cap → DELIVERY_UNCERTAIN. ' +
      // Name and code only: a QueryFailedError carries the bound parameters (the fencing token) as an own property.
      `Last error: ${describeErrorForLog(lastError)}.`,
  );
  throw new SentWriteFailedError(row.id, lastError);
}

/** `Name/code` of an error for a log line — never its message or own properties (bound query parameters, tokens). */
function describeErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' || typeof code === 'number' ? `${error.name}/${code}` : error.name;
  }
  return typeof error;
}

/** `code` is written to `email_outbox.last_error_code`; `auditReasonCode` (S-6) refines it in the audit row only. */
type Revalidation = { ok: true } | { ok: false; reason: string; code?: string; auditReasonCode?: string };

async function revalidate(manager: EntityManager, row: EmailOutbox): Promise<Revalidation> {
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
    // Phase D-Q (owner decision "always queue"): an invite queued while the Worker was down can reach this point long
    // after it was issued. An expired invite carries a link the activation endpoint would refuse anyway — never send it
    // (fail closed: cancelled, like the member/organisation invitations and the reset token below).
    if (!(invite.expiresAt instanceof Date) || Number.isNaN(invite.expiresAt.getTime()) || invite.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'Invitation expired before delivery.' };
    }
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

/**
 * Attachment revalidation (report PDFs), run under `runInWorkspaceContext` for the row's own workspace — so `stored_file`
 * (core) and the workspace tables `shift_report`, `shift` and `manager_venue` are all read from the RIGHT place in both
 * runtime modes, with the workspace bound for their RLS.
 *
 * PHASE 5 (§14) — the pre-shift roster+QR email is only ever correct while the shift it describes is still active; a
 * shift cancelled between `shift-report-scheduler.job.ts` enqueueing this row and this worker sending it must not still
 * go out claiming an active roster. Uses the structured linkage the file already carries (`stored_file.resource_type =
 * 'shift_report'`, `resource_id` = the `ShiftReport` row id). The final Timesheet PDF is historical truth once a manager
 * has finalised the report and is never suppressed by a later cancellation.
 *
 * Report recipients (roster + Shift QR, final timesheet) are re-checked immediately before sending with the SAME rule the
 * jobs applied at enqueue time (report-recipients.ts): a manager deactivated, unassigned from the venue, deleted, stripped
 * of `report.view`, or whose organisation was suspended after this row was queued must not receive the PDF or the QR.
 * Only NOTIFICATION rows carrying one of the two report files; a report whose shift can no longer be resolved cannot
 * prove its recipient, so it fails closed (cancelled).
 */
async function revalidateAttachment(manager: EntityManager, row: EmailOutbox, permissions: ReportPermissionChecker): Promise<Revalidation> {
  const file = await manager.findOne(StoredFile, { where: { id: row.attachmentFileId! } });
  const isReportFile = file?.kind === FileKind.SHIFT_ROSTER_PDF || file?.kind === FileKind.FINAL_TIMESHEET_PDF;
  const report = isReportFile && file.resourceType === 'shift_report' ? await manager.findOne(ShiftReport, { where: { id: file.resourceId } }) : null;
  const shift = report ? await manager.findOne(Shift, { where: { id: report.shiftId } }) : null;
  if (file?.kind === FileKind.SHIFT_ROSTER_PDF && file.resourceType === 'shift_report') {
    if (!shift || shift.status === ShiftStatus.CANCELLED) {
      return { ok: false, reason: 'The shift this roster is for has been cancelled since it was queued.' };
    }
  }
  if (isReportFile && row.jobType === EmailOutboxJobType.NOTIFICATION) {
    const check = shift
      ? await checkReportRecipient(
          manager,
          { organisationId: row.organisationId, workspaceId: row.workspaceId ?? null, venueId: shift.venueId },
          permissions,
          row.targetUserId,
        )
      : { eligible: false, organisationSuspended: false };
    if (!check.eligible) {
      return {
        ok: false,
        reason: 'The recipient is no longer eligible to receive this report.',
        code: REPORT_RECIPIENT_INELIGIBLE,
        auditReasonCode: check.organisationSuspended ? REPORT_EMAIL_REASON_ORGANISATION_SUSPENDED : REPORT_RECIPIENT_INELIGIBLE,
      };
    }
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
 *
 * D-Q5b (OC-1): final when the error is permanent or this attempt's CUMULATIVE count (from the claim) reached the row's
 * cap — no longer when the current BullMQ job ran out of its own attempts. If a job's BullMQ attempts run out first
 * (attempts spent before any claim), the row keeps the open status it had and the dispatcher's matching stale rule
 * republishes it under a new generation until the cumulative cap is reached: a row that was never claimed (e.g. not yet
 * visible on a fresh row) is PENDING or QUEUED and comes back through the stale-QUEUED rule; a row an earlier attempt
 * left RETRY comes back through the stale-RETRY rule.
 */
async function handleSendFailure(
  deps: EmailSendProcessorDeps,
  ctx: AuthContext,
  row: EmailOutbox,
  job: Job<EmailQueueJobData>,
  processingToken: string,
  attempt: ClaimedAttempt,
  error: unknown,
): Promise<void> {
  const verdict = classifyEmailSendError(error);
  const retryable = verdict.retryable;
  const sanitized = sanitizeErrorMessage(error, row.recipientEmail);
  const code = (error as { code?: string })?.code ?? (error as { name?: string })?.name ?? 'UNKNOWN';
  const isFinal = !retryable || attempt.count >= attempt.max;
  // D5: a provider-throttled failure (Resend 429 retry-after) is re-delayed without consuming an attempt. Decided before
  // the write so the throttled attempt gives its count back (recorded count = this attempt - 1), as when the count was
  // job-relative; the last allowed attempt is never re-delayed (it is final, unchanged).
  const delayMs = isFinal ? null : throttleDelayMs(verdict);
  const throttled = delayMs !== null && Boolean(job.token) && (job.attemptsStarted ?? 0) < THROTTLE_MAX_STARTS;
  const recordedCount = throttled ? attempt.count - 1 : attempt.count;

  const wroteAsOwner = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
    const write = await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({
        status: isFinal ? EmailOutboxStatus.FAILED : EmailOutboxStatus.RETRY,
        infrastructureAttemptCount: recordedCount,
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
        metadata: { emailOutboxId: row.id, jobType: row.jobType, errorCode: code, attempts: attempt.count, retryable },
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
  // D5: provider-reported throttling (Resend 429 retry-after). The row is already RETRY; instead of the generic jittered
  // backoff, wait what the provider asked for (clamped 1 s .. 2 min) by delaying THIS job (BullMQ DelayedError: no new
  // add(), so no jobId dedupe; the attempt is not consumed). Bounded by attemptsStarted so a provider that throttles
  // forever still ends through the normal attempts. Without a lock token (direct calls, tests) the normal path applies.
  if (throttled) {
    await job.moveToDelayed(Date.now() + delayMs!, job.token);
    throw new DelayedError(`email outbox row ${row.id} throttled by the provider; retrying in ${delayMs} ms`);
  }
  // Retryable and below the cap: the row is RETRY; BullMQ retries this job with its bounded jittered backoff. Never the
  // provider's own error object (its message and properties carry the recipient — see EmailSendAttemptError).
  const responseCode = (error as { responseCode?: unknown })?.responseCode;
  throw new EmailSendAttemptError(row.id, code, typeof responseCode === 'number' ? responseCode : undefined, sanitized);
}
