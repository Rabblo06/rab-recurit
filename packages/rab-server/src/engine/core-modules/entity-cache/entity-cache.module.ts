import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CoreEntityCacheService } from './core-entity-cache.service';
import { WorkspaceMetadataCacheService } from './workspace-metadata-cache.service';

/**
 * Redis checkpoint — Core Entity Cache + Workspace Metadata Cache. Imports `AuthModule` solely to
 * reuse its already-exported `AuthCacheRedisClientProvider` (same Redis deployment, same
 * fail-fast client every other hot-path cache in this codebase already uses) — no new `ioredis`
 * connection is created anywhere in this module.
 */
@Module({
  imports: [AuthModule],
  providers: [CoreEntityCacheService, WorkspaceMetadataCacheService],
  exports: [CoreEntityCacheService, WorkspaceMetadataCacheService],
})
export class EntityCacheModule {}
