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
    // OWNER-DB-ULTIMATE Part B (owner decision 2026-11-14): an informational `upgrade: { status: 'up', upgradeFailed: true|false }`
    // entry says only whether the code version's upgrade failed (upgrade-status.ts): no version, step, state or error text
    // publicly (the detail is on the platform-admin health report). Always `up`, so the status stays 200.
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 5_000 }),
      () => this.securityPosture(),
      // OWNER-DB-ULTIMATE Part B: a boolean only, derived from the upgrade logbook (upgrade-status.service.ts).
      async () => upgradeStatusIndicator(this.upgrades ? (await this.upgrades.status()).state : undefined),
    ]);
  }

  private securityPosture(): HealthIndicatorResult {
    if (securityReady()) return { security: { status: 'up' } };
    throw new HealthCheckError('security posture drift', { security: { status: 'down', reason: 'security-posture-drift' } });
  }
}
