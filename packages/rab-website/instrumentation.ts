import * as Sentry from '@sentry/nextjs';
// The site has no proxy/middleware or edge routes, so only the Node.js runtime
// is initialised. Add a sentry.edge.config.ts if an edge runtime is introduced.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
}
export const onRequestError = Sentry.captureRequestError;
