import { Module } from '@nestjs/common';

import { AuthModule } from '../../core-modules/auth/auth.module';
import { MetadataCacheService } from './metadata-cache.service';

/**
 * Metadata engine E5. Imports `AuthModule` only to reuse its exported `AuthCacheRedisClientProvider` (the same fail-fast
 * hot-path Redis client the entity and auth caches use; no new connection). The metadata engine's own module (E1, M1-meta)
 * imports this one.
 */
@Module({
  imports: [AuthModule],
  providers: [MetadataCacheService],
  exports: [MetadataCacheService],
})
export class MetadataCacheModule {}
