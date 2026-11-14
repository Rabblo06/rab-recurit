import { Global, Module } from '@nestjs/common';

import { UpgradeStatusService } from './upgrade-status.service';

/** OWNER-DB-ULTIMATE Part B: the upgrade logbook's read side for /healthz and the admin Health banner. */
@Global()
@Module({
  providers: [UpgradeStatusService],
  exports: [UpgradeStatusService],
})
export class UpgradeModule {}
