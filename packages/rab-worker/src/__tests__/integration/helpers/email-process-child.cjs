// Test-only independent OS process: real claim/processor, local fake provider.
const { DataSource } = require('typeorm');
const {
  coreDataSourceOptions,
} = require('@rab/server/database/typeorm/core/core.datasource');
const {
  TenantContextService,
} = require('@rab/server/engine/core-modules/tenant/tenant-context.service');
const {
  AuditService,
} = require('@rab/server/engine/core-modules/audit/audit.service');
const {
  runEmailDispatchCycle,
} = require('../../../queues/rab-email/email-dispatch.job');
const {
  createEmailSendProcessor,
} = require('../../../queues/rab-email/email-send.processor');
(async () => {
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    if (
      !['localhost', '127.0.0.1', '::1'].includes(
        new URL(process.env[key]).hostname,
      )
    )
      throw new Error('Local test databases only');
  }
  const app = await new DataSource(coreDataSourceOptions).initialize();
  const owner = await new DataSource({
    ...coreDataSourceOptions,
    url: process.env.DATABASE_URL_UNPOOLED,
  }).initialize();
  const tenantContext = new TenantContextService(app);
  process.send({ ready: true });
  process.once('message', async ({ id, organisationId }) => {
    try {
      let claims = 0;
      let sends = 0;
      const processor = createEmailSendProcessor({
        tenantContext,
        auditService: new AuditService(tenantContext),
        emailService: {
          ambiguousDeliverySafeToRetry: false,
          send: async () => {
            sends++;
            await new Promise((r) => setTimeout(r, 100));
            return { provider: 'LOGGER' };
          },
        },
      });
      await runEmailDispatchCycle(
        owner,
        tenantContext,
        async (claimedId) => {
          if (claimedId === id) claims++;
        },
        async () => undefined,
        false,
      );
      // Deliberately duplicate delivery from both processes, as a queue redelivery can.
      await processor({
        id,
        data: { emailOutboxId: id, organisationId },
        attemptsMade: 0,
        opts: { attempts: 5 },
      });
      await owner.destroy();
      await app.destroy();
      process.send({ claims, sends }, () => process.exit(0));
    } catch (e) {
      process.send({ error: e.message }, () => process.exit(1));
    }
  });
})().catch((e) => {
  process.send({ error: e.message }, () => process.exit(1));
});
