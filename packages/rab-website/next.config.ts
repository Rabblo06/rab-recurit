import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
const config: NextConfig = {
  poweredByHeader: false,
  // Sentry's treeshake.removeDebugLogging is webpack-only; this is the same
  // flag for Turbopack. Booleans, not strings: 'false' is a truthy literal.
  compiler: { define: { __SENTRY_DEBUG__: false } },
  turbopack: { root: process.cwd() },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
// Source maps upload only when SENTRY_AUTH_TOKEN is set in the build
// environment (CI/deploy); local builds skip the upload.
export default withSentryConfig(config, {
  org: 'rab-dc',
  project: 'rab',
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
