import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * The public /healthz upgrade indicator. Owner decision 2026-11-14 (OWNER-DB-ULTIMATE Part B): the public endpoint says ONLY
 * whether the code version's upgrade failed — `upgrade: { status: 'up', upgradeFailed: true | false }` — never a version,
 * a step name, a state word or error text. The detail (state, step, versions, attempt) is on the platform-admin health
 * report only (platform-admin/admin-health.service.ts, upgradeCard). Always `up`: informational, so /healthz stays 200.
 * The former CREWFLOW_UPGRADE_INCOMPLETE signal is retired (refused at start).
 */
export function upgradeStatusIndicator(ledgerState?: string): HealthIndicatorResult {
  return { upgrade: { status: 'up', upgradeFailed: ledgerState === 'failed' } };
}
