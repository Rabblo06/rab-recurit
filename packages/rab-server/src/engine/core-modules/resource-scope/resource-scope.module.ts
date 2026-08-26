import { Global, Module } from '@nestjs/common';

import { ResourceScopeService } from './resource-scope.service';

/** Same lean, import-free shape as `PlatformAdminModule` — `ResourceScopeService` depends only on `PlatformAdminService` (also `@Global()`), so no `AuthModule` import is needed or wanted here. */
@Global()
@Module({
  providers: [ResourceScopeService],
  exports: [ResourceScopeService],
})
export class ResourceScopeModule {}
