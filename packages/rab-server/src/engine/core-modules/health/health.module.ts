import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { UpgradeModule } from '../upgrade/upgrade.module';

@Module({
  imports: [TerminusModule, UpgradeModule],
  controllers: [HealthController],
})
export class HealthModule {}
