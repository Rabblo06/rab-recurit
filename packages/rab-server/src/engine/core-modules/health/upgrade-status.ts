import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * OWNER-DB-ULTIMATE Part B3: /healthz reports the upgrade logbook's state (engine/core-modules/upgrade/upgrade-status.service.ts).
 * The former CREWFLOW_UPGRADE_INCOMPLETE signal is retired (refused at start). Never a step name or an error message.
 */
/**
 * The /healthz indicator. Always `up`: informational only; never a migration or step name, never an error message.
 * OWNER-DB-ULTIMATE Part B3: `upgrade` carries the logbook state (upgrade-status.service.ts) when it is known, and
 * `upgradeFailed` (kept for compatibility) is also true when the logbook says the code version's upgrade failed.
 */
export function upgradeStatusIndicator(ledgerState?: string): HealthIndicatorResult {
  const failed = ledgerState === 'failed';
  return { upgrade: { status: 'up', upgradeFailed: failed, ...(ledgerState ? { upgrade: ledgerState } : {}) } };
}
