// Test-only independent OS process (email-twenty): the REAL email processor and the REAL SmtpDriver (nodemailer) against the
// parent test's local SMTP sink. The parent SIGKILLs this process while the sink holds the complete message, which is a real
// Worker crash in the middle of an SMTP transaction (no outcome is ever recorded).
const { DataSource } = require('typeorm');
const { coreDataSourceOptions } = require('@rab/server/database/typeorm/core/core.datasource');
const { TenantContextService } = require('@rab/server/engine/core-modules/tenant/tenant-context.service');
const { SchemaResolverService } = require('@rab/server/engine/core-modules/tenant/schema-resolver.service');
const { AuditService } = require('@rab/server/engine/core-modules/audit/audit.service');
const { SmtpDriver } = require('@rab/server/engine/core-modules/email/drivers/smtp.driver');
const { createEmailSendProcessor } = require('../../../queues/rab-email/email-send.processor');

(async () => {
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Local test databases only');
  const port = Number(process.env.ETW_SMTP_SINK_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ETW_SMTP_SINK_PORT is required');
  const app = await new DataSource(coreDataSourceOptions).initialize();
  // Same minimal environment as email-process-child.cjs: HWS off in this legacy-mode test.
  const tenantContext = new TenantContextService(app, new SchemaResolverService(), {
    get: (key) => (key === 'HWS_RUNTIME_ENABLED' ? false : undefined),
  });
  // Long timeouts on purpose: this process must still be inside sendMail when the parent kills it.
  const driver = new SmtpDriver({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }, { socketTimeoutMs: 120000, sendDeadlineMs: 120000 });
  const processor = createEmailSendProcessor({
    tenantContext,
    auditService: new AuditService(tenantContext),
    emailService: {
      ambiguousDeliverySafeToRetry: driver.ambiguousDeliverySafeToRetry,
      send: (options) => driver.send({ ...options, from: 'noreply@example.test' }),
    },
  });
  process.send({ ready: true });
  process.once('message', async ({ id, organisationId }) => {
    try {
      await processor({ id: `email-outbox.${id}.attempt.0`, data: { emailOutboxId: id, organisationId }, attemptsMade: 0, opts: { attempts: 5 } });
      process.send({ finished: true }); // not expected: the parent kills this process first
    } catch (e) {
      process.send({ error: e.message });
    }
  });
})().catch((e) => {
  process.send({ error: e.message }, () => process.exit(1));
});
