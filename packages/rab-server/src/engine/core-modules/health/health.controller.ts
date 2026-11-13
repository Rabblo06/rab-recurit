import { Controller, Get, Optional } from '@nestjs/common';
import { HealthCheck, HealthCheckError, HealthCheckService, HealthIndicatorResult, TypeOrmHealthIndicator } from '@nestjs/terminus';

import { securityReady } from './security-readiness';
import { upgradeStatusIndicator } from './upgrade-status';
import { UpgradeStatusService } from '../upgrade/upgrade-status.service';

/** Render's healthCheckPath (render.yaml) points here. */
@Controller('healthz')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    @Optional() private readonly upgrades?: UpgradeStatusService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    // Terminus defaults to a 1000ms ping timeout — too tight for a managed
    // Postgres (Neon) under normal latency variance (confirmed in production:
    // spurious "down" readings with no real outage, which risk the
    // deployment platform restarting a healthy container). 5s stays well
    // under this endpoint's own request timeout while tolerating a slow
    // moment without false-flagging.
    // Owner-login architecture: also unready once the semantic posture monitor saw the database's security objects change
    // since boot (security-readiness.ts). It stays unready until a restart passes the boot check again.
    // O3 C3: an informational `upgrade: { status: 'up', upgradeFailed: true|false }` entry says whether this start follows a
    // failed upgrade served under CREWFLOW_UPGRADE_FAILURE=continue (upgrade-status.ts). Never the migration's name (that
    // stays in the start-up logs); always `up`, so the status stays 200 by the owner's decision.
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 5_000 }),
      () => this.securityPosture(),
      // OWNER-DB-ULTIMATE Part B3: plus the logbook's state (ok / failed / behind / ahead / none / unknown), never a name.
      async () => upgradeStatusIndicator(process.env, this.upgrades ? (await this.upgrades.status()).state : undefined),
    ]);
  }

  private securityPosture(): HealthIndicatorResult {
    if (securityReady()) return { security: { status: 'up' } };
    throw new HealthCheckError('security posture drift', { security: { status: 'down', reason: 'security-posture-drift' } });
  }
}
