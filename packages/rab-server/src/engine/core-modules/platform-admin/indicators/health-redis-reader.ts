import type Redis from 'ioredis';

/**
 * Phase X Part 2, X2.4: the ONLY Redis surface the health indicators get — read commands, nothing else (owner:
 * "read-only Redis/DB calls only"). Typed as a `Pick` so an indicator that tries `set`, `del`, `eval` or a pipeline does
 * not compile; `admin-health-indicators.integration.spec.ts` also checks every command that reaches Redis against the
 * server's own `COMMAND INFO` flags (no `write` flag allowed).
 */
export type HealthRedisReader = Pick<Redis, 'info' | 'get' | 'hgetall' | 'llen' | 'zcard'>;
