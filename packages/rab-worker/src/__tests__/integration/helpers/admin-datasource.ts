import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { coreDataSourceOptions } from '@rab/server/database/typeorm/core/core.datasource';
import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';

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
 * The URL comes ONLY from TEST_DATABASE_URL_UNPOOLED, validated by the shared
 * guard (same logical database and endpoint as the application connection; no
 * remote host without ALLOW_REMOTE_TEST_DATABASE=true). Never DATABASE_URL_UNPOOLED,
 * which the developer's .env can point at a remote database.
 *
 * HWS runtime cutover, Part 2 consequence (see `rab-server`'s identical copy of this helper for
 * the full explanation): `coreDataSourceOptions` no longer has a static `schema: 'core'` default,
 * so this admin/fixture-only connection needs its own explicit `search_path=core` or any fixture
 * helper writing a schema-less workspace entity (`JobRole`, `Venue`, `StaffProfile`, ...) over it
 * fails with "relation ... does not exist." Scoped to this connection only — never the app's own
 * runtime DataSource, which still resolves search_path per-transaction via `TenantContextService`.
 */
export function createAdminDataSource(): DataSource {
  const { adminUrl } = resolveIntegrationTestDatabase(process.env);
  const baseOptions = coreDataSourceOptions as PostgresConnectionOptions;
  return new DataSource({
    ...baseOptions,
    url: adminUrl,
    name: `admin-${Math.random().toString(36).slice(2)}`,
    extra: { ...(baseOptions.extra as object | undefined), options: '-c search_path=core' },
  });
}
