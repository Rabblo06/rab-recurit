import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckError, HealthCheckService, HealthIndicatorResult, TypeOrmHealthIndicator } from '@nestjs/terminus';

import { securityReady } from './security-readiness';

/** Render's healthCheckPath (render.yaml) points here. */
@Controller('healthz')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
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
    return this.health.check([() => this.db.pingCheck('database', { timeout: 5_000 }), () => this.securityPosture()]);
  }

  private securityPosture(): HealthIndicatorResult {
    if (securityReady()) return { security: { status: 'up' } };
    throw new HealthCheckError('security posture drift', { security: { status: 'down', reason: 'security-posture-drift' } });
  }
}
