import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CoreEntityCacheService } from './core-entity-cache.service';
import { MetadataL1CacheService } from './metadata-l1-cache.service';
import { PermissionCatalogueCacheService } from './permission-catalogue-cache.service';
import { WorkspaceMetadataCacheService } from './workspace-metadata-cache.service';

/**
 * Redis checkpoint — Core Entity Cache + Workspace Metadata Cache. Imports `AuthModule` solely to
 * reuse its already-exported `AuthCacheRedisClientProvider` (same Redis deployment, same
 * fail-fast client every other hot-path cache in this codebase already uses) — no new `ioredis`
 * connection is created anywhere in this module.
 */
@Module({
  imports: [AuthModule],
  // Wave 5 lane OPS: MetadataL1CacheService (in-process L1 for non-authorisation metadata, METADATA_L1_CACHE_ENABLED,
  // default off) and PermissionCatalogueCacheService (static flag catalogue). Both reuse the same Redis client.
  providers: [CoreEntityCacheService, WorkspaceMetadataCacheService, MetadataL1CacheService, PermissionCatalogueCacheService],
  exports: [CoreEntityCacheService, WorkspaceMetadataCacheService, MetadataL1CacheService, PermissionCatalogueCacheService],
})
export class EntityCacheModule {}
