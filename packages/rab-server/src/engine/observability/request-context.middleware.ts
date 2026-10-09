import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

import { publishRequestComplete, runWithRequestContext } from './request-context';

/**
 * P1A — the one global request-correlation/metrics middleware. Registered FIRST in
 * `app.module.ts`'s `configure()` (before `cookie-parser`), so the AsyncLocalStorage context
 * this opens wraps the entire request lifecycle, including every guard, every
 * `TenantContextService` transaction, and every SQL statement `SlowQueryLogger` observes.
 *
 * Emits exactly one structured log line per request, on `finish` — never per-query, never
 * mid-request. SAFETY: see `request-context.ts`'s own doc comment for what this never logs
 * (tokens, cookies, emails, ids, SQL). `req.route?.path` is a RubyonRails/Express ROUTE
 * TEMPLATE (e.g. `/staff/:id`), already free of any real id, exactly the "route template"
 * A1 asks for — never `req.path`/`req.originalUrl`, which would contain the real id.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const start = performance.now();
    const value = {
      requestId,
      method: req.method,
      routeTemplate: req.path,
      startedAt: Date.now(),
      metrics: { sqlCount: 0, transactionCount: 0, stages: {} },
    };

    runWithRequestContext(value, () => {
      res.on('finish', () => {
        // Prefer the matched route's own template (set once Express has resolved the handler);
        // req.path alone would otherwise embed a real resource id for most of this API's routes.
        const routeTemplate = (req.route?.path as string | undefined)
          ? `${req.baseUrl}${req.route!.path}`
          : value.routeTemplate;
        const durationMs = Math.round(performance.now() - start);
        const payload = {
          requestId,
          method: req.method,
          route: routeTemplate,
          status: res.statusCode,
          durationMs,
          sqlCount: value.metrics.sqlCount,
          transactionCount: value.metrics.transactionCount,
          stages: value.metrics.stages,
        };
        this.logger.log({ event: 'request_complete', ...payload });
        publishRequestComplete(payload);
      });
      next();
    });
  }
}
