import { Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { currentPgProcessRole, resolvePgEnvironmentCached } from '../postgres';
import { assertConnectionBudget } from './connection-budget';
import { databaseMetrics, registerDataSourcePoolMetrics } from './database-metrics';
import { PgReplicaService } from './replica/pg-replica.service';

/** How often the pool/replica summary is logged (numbers and fixed names only). */
export const DATABASE_METRICS_LOG_INTERVAL_MS = 5 * 60_000;

/**
 * Phase B (B5) boot work for the API and Worker processes:
 *   - the connection-budget check (connection-budget.ts) against the primary — refuses startup when the declared
 *     deployment cannot fit, warns when the instance counts are not declared;
 *   - pool metrics on the primary pool (the Worker's direct pool is registered by its main.ts after it initialises);
 *   - a periodic one-line metrics summary in the log. No endpoint.
 * The CLI, migrate and provisioner never import this as a boot step (their process role is not api/worker), and under
 * NODE_ENV=test only the metrics registration runs (the budget rules have their own unit tests).
 */
@Injectable()
export class DatabaseRuntimeBootstrap implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('DatabaseRuntime');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    registerDataSourcePoolMetrics('primary', this.dataSource);
    const role = currentPgProcessRole();
    if ((role !== 'api' && role !== 'worker') || process.env.NODE_ENV === 'test') return;
    await assertConnectionBudget({
      processRole: role,
      ownPoolMax: resolvePgEnvironmentCached(process.env).pool.max,
      env: process.env,
      query: (sql) => this.dataSource.query(sql),
      log: (line) => (line.includes('WARNING') ? this.logger.warn(line) : this.logger.log(line)),
    });
    this.timer = setInterval(() => {
      for (const line of databaseMetrics.summaryLines()) this.logger.log(line);
    }, DATABASE_METRICS_LOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

@Module({
  providers: [PgReplicaService, DatabaseRuntimeBootstrap],
  exports: [PgReplicaService],
})
export class DatabaseRuntimeModule {}
