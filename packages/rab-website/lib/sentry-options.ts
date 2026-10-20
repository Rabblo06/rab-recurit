// Shared by instrumentation-client.ts and sentry.server.config.ts.
// No DSN (local dev, CI, previews) means the SDK stays inert and sends nothing.
// Visitors are job candidates and employers, and the privacy/cookie text is not
// yet approved, so every SDK v11 data category that defaults to "collect" is
// switched off. userInfo also gates IP inference ({{auto}}) on both runtimes.
// No Session Replay for the same reason.
export const sentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
  },
};
