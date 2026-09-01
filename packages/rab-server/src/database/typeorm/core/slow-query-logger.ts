import { Logger as NestLogger } from '@nestjs/common';
import type { Logger as TypeOrmLogger } from 'typeorm';

const SLOW_QUERY_THRESHOLD_MS = 1000;

/**
 * Replaces TypeORM's own default logger (`AdvancedConsoleLogger`/
 * `SimpleConsoleLogger`) rather than layering on top of it, because that
 * default ALSO prints bound `parameters` on `logQueryError` — confirmed
 * directly in this session's own test output (`-- PARAMETERS: [...]`,
 * including real ids/values, on every RLS/constraint-violation error). This
 * class fixes that alongside adding the new `logQuerySlow` capability:
 * `parameters` is deliberately never read anywhere in this file — every
 * method below emits only the query TEXT (already parameterized `$1`/`$2`
 * placeholders throughout this codebase, never string-interpolated SQL, so
 * it holds no inlined literal value to begin with) plus an error message
 * where relevant, never the values bound to it.
 *
 * `logQuery` (successful, non-slow queries) stays a no-op — this codebase's
 * existing `logging: ['error','warn']` config never enabled full query
 * logging either, and there's no operational need for it.
 */
export class SlowQueryLogger implements TypeOrmLogger {
  private readonly logger = new NestLogger('Database');

  logQuerySlow(time: number, query: string): void {
    this.logger.warn({
      event: 'slow_query',
      durationMs: time,
      operation: extractOperation(query),
      queryFingerprint: fingerprint(query),
    });
  }

  logQueryError(error: string | Error, query: string): void {
    this.logger.error({
      event: 'query_error',
      operation: extractOperation(query),
      queryFingerprint: fingerprint(query),
      message: error instanceof Error ? error.message : error,
    });
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') this.logger.warn({ event: 'db_driver', message });
  }

  logQuery(..._args: unknown[]): void {}
  logSchemaBuild(..._args: unknown[]): void {}
  logMigration(..._args: unknown[]): void {}
}

function extractOperation(query: string): string {
  const match = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.exec(query);
  return match ? match[1]!.toUpperCase() : 'OTHER';
}

/**
 * Collapses whitespace and caps length — a log-line hygiene concern, not a
 * secrecy one (see the class doc comment for why the query text itself is
 * already safe).
 */
function fingerprint(query: string): string {
  const collapsed = query.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

export { SLOW_QUERY_THRESHOLD_MS };
