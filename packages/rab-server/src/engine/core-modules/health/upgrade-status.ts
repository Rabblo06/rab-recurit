import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * O3 C3 (owner decision 2026-11-05, "exactly like Twenty"): after a FAILED schema upgrade under
 * CREWFLOW_UPGRADE_FAILURE=continue, api-prestart.sh starts main.js with CREWFLOW_UPGRADE_INCOMPLETE=<failed migration>
 * (it refuses an inherited value, so only the entrypoint sets it). /healthz reports ONLY whether that happened —
 * `upgrade: { status: 'up', upgradeFailed: true | false }` — and stays 200: the API serves on the previous schema by the
 * owner's decision. Coordinator decision (2026-11-05, the stricter option): the migration's NAME is never exposed on
 * /healthz; it appears only in the start-up ERROR/WARNING logs.
 */
export const UPGRADE_INCOMPLETE_ENV = 'CREWFLOW_UPGRADE_INCOMPLETE';

/** True when this API start follows a failed upgrade (CREWFLOW_UPGRADE_INCOMPLETE set by api-prestart.sh). */
export function upgradeFailed(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[UPGRADE_INCOMPLETE_ENV];
  return value !== undefined && value !== '';
}

/** The /healthz indicator. Always `up`: informational only; a boolean, never the migration name. */
export function upgradeStatusIndicator(env: Record<string, string | undefined> = process.env): HealthIndicatorResult {
  return { upgrade: { status: 'up', upgradeFailed: upgradeFailed(env) } };
}
