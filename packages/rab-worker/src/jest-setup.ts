// class-validator/TypeORM decorators (imported transitively via @rab/server
// entities) need reflect-metadata loaded before any decorated class is
// touched — see rab-server's own jest-setup.ts for the identical reasoning.
import 'reflect-metadata';

// Test database routing: NODE_ENV must be test (any other value under Jest is refused, X1.2), TEST_DATABASE_URL and
// TEST_DATABASE_URL_UNPOOLED are required and validated, an inherited database URL that would redirect a connection is
// refused, and DATABASE_URL names are pointed at that pair. The developer's .env is never a fallback. See rab-server's
// test-database-guard.ts (shared via the compiled @rab/server package).
import { applyIntegrationTestDatabaseEnv } from '@rab/server/database/typeorm/core/test-database-guard';

applyIntegrationTestDatabaseEnv(process.env);
