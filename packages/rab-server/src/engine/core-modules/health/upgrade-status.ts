import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * O3 C3 (owner decision 2026-11-05, "exactly like Twenty"): after a FAILED schema upgrade under
 * CREWFLOW_UPGRADE_FAILURE=continue, api-prestart.sh starts main.js with CREWFLOW_UPGRADE_INCOMPLETE=<failed migration>
 * (it refuses an inherited value, so only the entrypoint sets it). /healthz then reports it as an INFORMATIONAL field —
 * `upgrade: { status: 'up', upgradeFailed: '<migration>' }` — and stays 200: the API serves on the previous schema by the
 * owner's decision; the field makes the degraded state visible to operators and monitors. Absent when the variable is unset.
 *
 * Only a migration name ever leaves (env validation and this function both require letters, digits, `_`, `-`, `.`, at most
 * 200 characters); anything else is reported as `unknown`, never echoed.
 */
export const UPGRADE_INCOMPLETE_ENV = 'CREWFLOW_UPGRADE_INCOMPLETE';
const MIGRATION_NAME = /^[A-Za-z0-9_.-]{1,200}$/;

export function upgradeFailedMigration(env: Record<string, string | undefined> = process.env): string | null {
  const value = env[UPGRADE_INCOMPLETE_ENV];
  if (value === undefined || value === '') return null;
  return MIGRATION_NAME.test(value) ? value : 'unknown';
}

/** The /healthz indicator, or null when the last upgrade did not fail. Always `up`: informational only. */
export function upgradeStatusIndicator(env: Record<string, string | undefined> = process.env): HealthIndicatorResult | null {
  const failed = upgradeFailedMigration(env);
  return failed === null ? null : { upgrade: { status: 'up', upgradeFailed: failed } };
}
