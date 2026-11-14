import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { createDatabaseLoginProbeClient, DATABASE_LOGIN_PROBE_CLIENT, DatabaseLoginHealthIndicator } from './database-login.health';
import { HealthController } from './health.controller';
import { UpgradeModule } from '../upgrade/upgrade.module';

@Module({
  imports: [TerminusModule, UpgradeModule],
  controllers: [HealthController],
  providers: [DatabaseLoginHealthIndicator, { provide: DATABASE_LOGIN_PROBE_CLIENT, useValue: createDatabaseLoginProbeClient }],
})
export class HealthModule {}
