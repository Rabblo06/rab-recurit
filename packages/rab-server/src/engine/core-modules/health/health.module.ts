import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { createDatabaseLoginProbeClient, DATABASE_LOGIN_PROBE_CLIENT, DatabaseLoginHealthIndicator } from './database-login.health';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseLoginHealthIndicator, { provide: DATABASE_LOGIN_PROBE_CLIENT, useValue: createDatabaseLoginProbeClient }],
})
export class HealthModule {}
