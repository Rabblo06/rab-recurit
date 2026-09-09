import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { UserDeletionService } from './user-deletion.service';

// `AuthModule` (not itself Global) is the only place `RefreshTokenService`
// is provided/exported — needed here to revoke a deleted user's sessions.
// `AuditService`/`PlatformAdminService` need no explicit import since
// `AuditModule`/`PlatformAdminModule` are both Global.
@Global()
@Module({
  imports: [AuthModule],
  providers: [UserDeletionService],
  exports: [UserDeletionService],
})
export class UserDeletionModule {}
