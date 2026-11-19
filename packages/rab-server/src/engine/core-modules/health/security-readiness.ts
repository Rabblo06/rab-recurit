import type { DataSource } from 'typeorm';

import { isPgProductionEnvironment } from '../../../database/postgres/pg-config';
import { SemanticPostureMonitor } from '../../../database/posture-drift/semantic-posture-monitor';
import type { SemanticPosture } from '../../../database/posture-drift/semantic-posture';
import { createSecurityAuditSink, securityAuditSinkConfig, SecurityAuditSink } from '../audit-sink/security-audit-sink';

/**
 * Owner-login architecture (M0 §6.4 controls 4 and 5; Agent 3's pieces, wired by the API and the Worker): the security
 * readiness flag. Process-wide, no I/O. `securityReady()` is true until a registered provider says otherwise; the API's
 * existing /healthz reports it (HealthController), the Worker exits on it (its restart then meets the boot refusal).
 */
const providers: Array<() => boolean> = [];

export function registerSecurityReadiness(provider: () => boolean): void {
  providers.push(provider);
}

export function securityReady(): boolean {
  return providers.every((ready) => {
    try {
      return ready();
    } catch {
      return false; // a provider that throws is not ready (fail closed)
    }
  });
}

/** Test seam only. */
export function resetSecurityReadinessForTests(): void {
  providers.length = 0;
}

export interface SecurityPostureMonitoring {
  sink: SecurityAuditSink;
  monitor: SemanticPostureMonitor | null;
  stop(): void;
}

/**
 * Starts, after the boot gates passed: the external security audit sink (securityAuditSinkConfig: fail closed — an invalid
 * configuration throws, and production refuses `none`), and the semantic posture monitor seeded with the boot gate's
 * baseline (database-boot-gates.ts `semanticBaseline`), on sessions of the process's own login from `dataSource`, with its
 * `ready()` registered as security readiness. No baseline (a gate that did not read one) → no monitor, said once.
 */
export function startSecurityPostureMonitoring(input: {
  dataSource: DataSource;
  baseline: SemanticPosture | undefined;
  processLabel: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  intervalMs?: number;
}): SecurityPostureMonitoring {
  const log = input.log ?? ((line: string) => console.error(line)); // eslint-disable-line no-console
  const sink = createSecurityAuditSink(securityAuditSinkConfig(input.env ?? process.env), { log });
  if (!input.baseline) {
    log(`[posture-monitor] WARNING ${input.processLabel}: no boot posture baseline was read, so the semantic posture monitor is not running`);
    return { sink, monitor: null, stop: () => undefined };
  }
  const monitor = new SemanticPostureMonitor({
    baseline: input.baseline,
    processLabel: input.processLabel,
    sink,
    log,
    intervalMs: input.intervalMs,
    // Production (the connection factory's own rule): a later ALTER DATABASE ... OWNER TO the login is a role problem too.
    production: isPgProductionEnvironment(input.env ?? process.env),
    session: async () => {
      const runner = input.dataSource.createQueryRunner();
      await runner.connect();
      // Security review L-3 (PR #257): the check reads catalogs only, inside ONE transaction whose search_path is pinned with
      // SET LOCAL (a pooled application connection cannot take a startup option), so a planted ALTER ROLE / ALTER DATABASE
      // search_path cannot shadow what it calls. Rolled back on release: nothing reaches the pool.
      try {
        await runner.startTransaction();
        await runner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', true)`);
      } catch (error) {
        await runner.release().catch(() => undefined);
        throw error;
      }
      return {
        query: (sql: string, params?: unknown[]) => runner.query(sql, params) as Promise<Array<Record<string, unknown>>>,
        release: async () => {
          await runner.rollbackTransaction().catch(() => undefined);
          await runner.release();
        },
      };
    },
  });
  registerSecurityReadiness(() => monitor.ready());
  monitor.start();
  return { sink, monitor, stop: () => monitor.stop() };
}
