import { Global, Module } from '@nestjs/common';

import { MemberAccessPolicyService } from './member-access-policy.service';

/**
 * Global so every read path that serves custom workspace-members (staff, venues, shifts, search, dashboard) can apply
 * the same object / field / record policy without new module import chains. Depends only on the global
 * ResourceScopeModule.
 */
@Global()
@Module({
  providers: [MemberAccessPolicyService],
  exports: [MemberAccessPolicyService],
})
export class MemberAccessModule {}
