// Test-only independent OS process: real claim/processor, local fake provider.
const { DataSource } = require('typeorm');
const {
  coreDataSourceOptions,
} = require('@rab/server/database/typeorm/core/core.datasource');
const {
  TenantContextService,
} = require('@rab/server/engine/core-modules/tenant/tenant-context.service');
const {
  SchemaResolverService,
} = require('@rab/server/engine/core-modules/tenant/schema-resolver.service');
const {
  AuditService,
} = require('@rab/server/engine/core-modules/audit/audit.service');
const {
  runEmailDispatchCycle,
} = require('../../../queues/rab-email/email-dispatch.job');
const {
  createEmailSendProcessor,
} = require('../../../queues/rab-email/email-send.processor');
const {
  isLoopbackAlias,
  resolveIntegrationTestDatabase,
} = require('@rab/server/database/typeorm/core/test-database-guard');
(async () => {
  // X3.5-S6: the admin (owner) connection is the VALIDATED test pair's admin URL (every X1.8 / X1.9 rule), never the legacy
  // DATABASE_URL_UNPOOLED the Jest setup used to write. The application connection is the factory's PG_DATABASE_URL.
  const testDb = resolveIntegrationTestDatabase(process.env);
  for (const host of [testDb.app.host, testDb.admin.host]) {
    if (!isLoopbackAlias(host))
      throw new Error('Local test databases only');
  }
  const app = await new DataSource(coreDataSourceOptions).initialize();
  const owner = await new DataSource({
    ...coreDataSourceOptions,
    url: testDb.adminUrl,
  }).initialize();
  // TenantContextService now takes (dataSource, schemaResolver, environment) — this script
  // predates that, caught live via "Cannot read properties of undefined (reading 'get')" when
  // runInTenantContext's own HWS_RUNTIME_ENABLED check ran against an undefined environment
  // (P2.2 fix). schemaResolver has no constructor deps; environment is a minimal fake covering
  // the one key TenantContextService actually reads here (confirmed by reading every
  // this.environment.* call site in that file, not assumed) — HWS is off in this legacy-mode test.
  const tenantContext = new TenantContextService(app, new SchemaResolverService(), {
    get: (key) => (key === 'HWS_RUNTIME_ENABLED' ? false : undefined),
  });
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
