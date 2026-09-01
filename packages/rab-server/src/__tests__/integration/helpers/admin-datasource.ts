import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { coreDataSourceOptions } from '../../../database/typeorm/core/core.datasource';

/**
 * A SEPARATE, `rab_owner`-connected DataSource for test bootstrap only —
 * creating a fresh `Organisation` row, seeding global `Permission` reference
 * data. Neither is something the running app ever does over its own
 * connection: `organisation`'s RLS policy (`id = current_org()`, no FORCE
 * exemption for `rab_app`) makes a brand-new org's own row structurally
 * uninsertable with no tenant context yet bound — in real life this only
 * ever happens via the CLI seed script (`rab_owner`), never `rab_app`. This
 * mirrors that split for tests, so the app's own DataSource
 * (`moduleRef.get(DataSource)`) can be `rab_app` — the real runtime role —
 * for everything that actually exercises RLS/auth, while this connection
 * covers the "owner/migration-style" setup a real seed script would do.
 *
 * Uses `DATABASE_URL_UNPOOLED` (already the project's own convention for
 * the `rab_owner` connection — see every migration-running script) rather
 * than a second, hardcoded connection string.
 */
export function createAdminDataSource(): DataSource {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  return new DataSource({
    ...(coreDataSourceOptions as PostgresConnectionOptions),
    url,
    name: `admin-${Math.random().toString(36).slice(2)}`,
  });
}
