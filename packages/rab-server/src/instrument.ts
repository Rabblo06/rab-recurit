/**
 * Must be imported before any other module in every entrypoint (main.ts,
 * packages/rab-worker/src/main.ts, packages/rab-server/src/command/main.ts) so Sentry can instrument
 * everything that loads after it.
 */
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
  });
}
