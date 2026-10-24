import { CycleContext } from '../../core/runtime/worker-runtime';
import { Process, Processor } from '../../core/scheduler/decorators';
import { SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runAccountInviteCleanupCycle } from './account-invite-cleanup.job';
import { runLoginHandoffCleanupCycle } from './login-handoff-cleanup.job';
import { runOutboxRetentionCycle } from './outbox-retention.job';
import { runStorageCleanupCycle } from './storage-cleanup.job';
import { runTokenCleanupCycle } from './token-cleanup.job';

/**
 * Thin adapters — the pre-migration main.ts loop bodies, verbatim (see rab-email/email.processors.ts). The two enable
 * switches (LOGIN_HANDOFF_CLEANUP_ENABLED, OUTBOX_RETENTION_ENABLED) stay inside the cycle exactly as before: a disabled
 * cycle does no work and returns `false`, so it is never stamped as a successful run in either scheduler mode.
 */
@Processor(SCAN_QUEUES.maintenance)
export class MaintenanceScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('account-invite-cleanup')
  async accountInviteCleanup(): Promise<void> {
    const { runtimeDataSource, logger } = this.deps.get();
    const result = await runAccountInviteCleanupCycle(runtimeDataSource);
    if (result.expired || result.deleted || result.retained) {
      logger.log(`account-invite cleanup: expired=${result.expired} deleted=${result.deleted} retained=${result.retained}`);
    }
  }

  @Process('token-cleanup')
  async tokenCleanup(): Promise<void> {
    const { runtimeDataSource, logger } = this.deps.get();
    const result = await runTokenCleanupCycle(runtimeDataSource);
    if (result.refreshTokensDeleted || result.passwordResetTokensDeleted || result.oauthTransactionsDeleted) {
      logger.log(
        `token cleanup: refreshTokens=${result.refreshTokensDeleted} passwordResetTokens=${result.passwordResetTokensDeleted} oauthTransactions=${result.oauthTransactionsDeleted}`,
      );
    }
  }

  // Wave 4/5 (DB5 contract §2, MFA-lane request): single-use cross-host login handoffs, purged 1 h past expiry/consumption
  // through DB5's core.login_handoff_cleanup. ON by default (security tokens, not records); own loop + stat keys, session
  // advisory lock (one replica per cycle), interval LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES. See login-handoff-cleanup.job.ts.
  @Process('login-handoff-cleanup')
  async loginHandoffCleanup(): Promise<boolean> {
    const { runtimeDataSource, directDataSource, environmentService, logger } = this.deps.get();
    const result = await runLoginHandoffCleanupCycle(runtimeDataSource, directDataSource, { enabled: environmentService.get('LOGIN_HANDOFF_CLEANUP_ENABLED') });
    if (result.ran && result.rowsDeleted) logger.log(`login handoff cleanup: deleted=${result.rowsDeleted} batches=${result.batches}`);
    return result.ran;
  }

  @Process('storage-cleanup')
  async storageCleanup(): Promise<void> {
    const { storageReconcileCommand, environmentService, logger } = this.deps.get();
    const result = await runStorageCleanupCycle(storageReconcileCommand, environmentService.get('STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS'));
    logger.log(`storage cleanup: checked=${result.checkedRows} integrityProblems=${result.integrityProblems} orphans=${result.orphans} actions=${result.actionsTaken}`);
  }

  // Wave 5 lane OPS (G6): terminal outbox/event retention. OUTBOX_RETENTION_ENABLED=false (default) → the cycle is a no-op
  // (no query, no delete); enabled starts in OUTBOX_RETENTION_MODE=report (counts only). Deletes go only through DB5's
  // core.purge_terminal_* functions under each tenant scope; one replica at a time (session advisory lock on the direct
  // connection). See queues/rab-maintenance/outbox-retention.job.ts.
  @Process('outbox-retention')
  async outboxRetention(ctx: CycleContext): Promise<boolean> {
    const { runtimeDataSource, directDataSource, tenantContext, environmentService: env, logger } = this.deps.get();
    const config = {
      enabled: env.get('OUTBOX_RETENTION_ENABLED'),
      mode: env.get('OUTBOX_RETENTION_MODE'),
      days: {
        email_outbox: env.get('OUTBOX_RETENTION_EMAIL_DAYS'),
        push_delivery: env.get('OUTBOX_RETENTION_PUSH_DAYS'),
        realtime_event: env.get('OUTBOX_RETENTION_REALTIME_DAYS'),
        worker_event: env.get('OUTBOX_RETENTION_WORKER_EVENT_DAYS'),
      },
      batchSize: env.get('OUTBOX_RETENTION_BATCH_SIZE'),
      maxBatchesPerScope: env.get('OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE'),
    };
    const result = await runOutboxRetentionCycle(runtimeDataSource, directDataSource, tenantContext, config);
    if (!result.ran) return false;
    const r = result.rows;
    logger.log(
      `outbox retention (${result.mode}${result.mode === 'report' ? ', counts only' : ''}): email=${r.email_outbox} push=${r.push_delivery} ` +
        `realtime=${r.realtime_event} workerEvent=${r.worker_event} scopes=${result.scopes} truncated=${result.truncated}`,
    );
    ctx.setStat('lastOutboxRetentionMode', String(result.mode));
    ctx.setStat('lastOutboxRetentionRows', r.email_outbox + r.push_delivery + r.realtime_event + r.worker_event);
    return true;
  }
}
