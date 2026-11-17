// class-validator/TypeORM decorators (imported transitively via @rab/server
// entities) need reflect-metadata loaded before any decorated class is
// touched — see rab-server's own jest-setup.ts for the identical reasoning.
import 'reflect-metadata';

// The one rate-limit switch (rab-server engine/core-modules/throttler/rate-limit-bypass.ts, X1.2) needs this to be exactly
// 'true'; JEST_WORKER_ID no longer counts and an unset flag keeps the limits on. Same value rab-server's jest-setup.ts sets, so
// worker suites that boot the API module keep the behaviour they had under the old JEST_WORKER_ID predicate.
process.env.RAB_DISABLE_RATE_LIMIT = 'true';

// Test database routing: NODE_ENV must be test (any other value under Jest is refused, X1.2), TEST_DATABASE_URL and
// TEST_DATABASE_ADMIN_URL are required and validated (X3.5-S8: the old name TEST_DATABASE_URL_UNPOOLED and the legacy
// database names are refused), an inherited database URL that would redirect a connection is refused, and PG_DATABASE_URL
// is pointed at the validated application URL (the legacy names are blanked). The developer's .env is never a fallback. See rab-server's
// test-database-guard.ts (shared via the compiled @rab/server package).
import { applyIntegrationTestDatabaseEnv } from '@rab/server/database/typeorm/core/test-database-guard';

applyIntegrationTestDatabaseEnv(process.env);
