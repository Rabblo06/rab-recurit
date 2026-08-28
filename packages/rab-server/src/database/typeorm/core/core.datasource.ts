// Entity decorators (@Entity, @Column, ...) need reflect-metadata loaded
// before they run. NestJS's own bootstrap (main.ts, via @nestjs/core) loads
// it as a side effect, but standalone consumers of this datasource
// (setup-db.ts, the TypeORM CLI) don't go through Nest at all — load it
// here, once, so every consumer gets it regardless of entrypoint.
import 'reflect-metadata';

import { DataSource, DataSourceOptions } from 'typeorm';

import * as attendanceEntities from '../../../modules/attendance/entities';
import * as identityEntities from '../../../modules/identity/entities';
import * as managerEntities from '../../../modules/manager/entities';
import * as managerWorkspaceEntities from '../../../modules/manager-workspace/entities';
import * as notificationEntities from '../../../modules/notification/entities';
import * as offerEntities from '../../../modules/offer/entities';
import * as schedulingEntities from '../../../modules/scheduling/entities';
import * as staffEntities from '../../../modules/staff/entities';
import * as venueEntities from '../../../modules/venue/entities';

/**
 * Single DataSource, schema `core`. `synchronize: false` always — every
 * schema change is a versioned migration, never edited after merge (see
 * CLAUDE.md and rab-workforce-architecture.md §11).
 *
 * Entities are explicit imports, not a glob pattern. A glob-resolved
 * `require()` and a normal relative `import` of the same .ts file can end
 * up as two distinct module instances under ts-node on Windows (mixed
 * forward/backslash path strings hit Node's require cache differently),
 * which manifests as `EntityMetadataNotFoundError` even though the file
 * genuinely got loaded — TypeORM registered metadata against a different
 * `Organisation` class object than the one every service imports. Explicit
 * imports guarantee both call sites reference the exact same class.
 */
export const coreDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  schema: 'core',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  entities: [
    ...Object.values(identityEntities),
    ...Object.values(staffEntities),
    ...Object.values(managerEntities),
    ...Object.values(managerWorkspaceEntities),
    ...Object.values(venueEntities),
    ...Object.values(schedulingEntities),
    ...Object.values(offerEntities),
    ...Object.values(notificationEntities),
    ...Object.values(attendanceEntities),
  ],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  migrationsTableName: 'migrations',
};

// Used by the TypeORM CLI (`migration:generate`, `migration:run`) and by
// the standalone setup-db / run-migrations scripts.
const coreDataSource = new DataSource(coreDataSourceOptions);

export default coreDataSource;
