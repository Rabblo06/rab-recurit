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
    // AI Phase 1: an event for an AI route never carries the request body (a question) or its query string. AI services
    // never put content into errors or logs; this is the backstop for Sentry's request-data integration.
    beforeSend(event) {
      if (event.request?.url && /\/rest\/v1\/(admin\/)?ai\//.test(event.request.url)) {
        delete event.request.data;
        delete event.request.query_string;
        delete event.request.cookies;
      }
      return event;
    },
  });
}
