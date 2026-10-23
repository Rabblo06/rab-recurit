import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validate } from './env.validation';
import { EnvironmentService } from './environment.service';
import { WorkspaceOriginTrustRegistry } from './workspace-origin-trust.registry';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
  ],
  providers: [EnvironmentService, WorkspaceOriginTrustRegistry],
  exports: [EnvironmentService, WorkspaceOriginTrustRegistry],
})
export class EnvironmentModule {}
