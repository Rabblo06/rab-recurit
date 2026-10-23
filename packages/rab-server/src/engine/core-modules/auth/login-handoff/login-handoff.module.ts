import { Module } from '@nestjs/common';

import { WorkspaceHostModule } from '../../workspace-host/workspace-host.module';
import { AuthModule } from '../auth.module';
import { LoginHandoffController } from './login-handoff.controller';
import { LoginHandoffService } from './login-handoff.service';

/**
 * Wave 4 lane MFA — cross-host login handoff. A module of its own (not inside AuthModule) because it needs lane H's
 * `WorkspaceHostResolverService`, and WorkspaceHostModule → EntityCacheModule → AuthModule already: importing it from
 * AuthModule would be a cycle. Engine-only (never imports `modules/`).
 */
@Module({
  imports: [AuthModule, WorkspaceHostModule],
  controllers: [LoginHandoffController],
  providers: [LoginHandoffService],
})
export class LoginHandoffModule {}
