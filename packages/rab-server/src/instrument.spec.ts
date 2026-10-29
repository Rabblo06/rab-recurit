/**
 * Phase 0 "Sentry": unit coverage for the privacy scrubbers in `instrument.ts`.
 *
 * Every hook is exercised through `buildSentryOptions(...)` (the exact object `Sentry.init` receives) as well as through
 * the exported scrubbers, on synthetic events carrying a Cookie, an Authorization bearer JWT, a `{password, token}`
 * body, a `?token=` query string, an email in the error message, a JWT and a `db.statement`. None of those values may
 * survive. Error types and stack frames must.
 */
import type { Breadcrumb, ErrorEvent, Event, NodeOptions } from '@sentry/node';

interface Integration {
  name: string;
  processEvent?: (
    event: Event,
    hint: unknown,
    client: unknown,
  ) => Event | null | PromiseLike<Event | null>;
}

delete process.env.SENTRY_DSN; // importing instrument.ts must never initialise Sentry in this process

// eslint-disable-next-line @typescript-eslint/no-var-requires
const instrument = require('./instrument') as typeof import('./instrument');
const {
  buildSentryOptions,
  parseSampleRate,
  redactString,
  resolveTracesSampleRate,
  scrubBreadcrumb,
  scrubErrorEvent,
  scrubSpan,
  scrubTransactionEvent,
  stripUrlQueryAndFragment,
} = instrument;

type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];
type TransactionEvent = Parameters<
  NonNullable<NodeOptions['beforeSendTransaction']>
>[0];

// Synthetic secrets: each is a unique marker so a leak anywhere in the serialised output is detectable.
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLXNlbnRyeS1qd3QtbWFya2VyIn0.c2lnLXNlbnRyeS1qd3Qtc2lnbmF0dXJl';
const JWT_PAYLOAD = 'eyJzdWIiOiJ1c2VyLXNlbnRyeS1qd3QtbWFya2VyIn0';
const COOKIE_VALUE = 'cookie-SECRET-c00k1e';
const COOKIE = `rab_session=${COOKIE_VALUE}; other=1`;
const PASSWORD = 'hunter2-PASSWORD-SECRET';
const BODY_TOKEN = 'body-TOKEN-SECRET-b0dy';
const QUERY_TOKEN = 'query-TOKEN-SECRET-qu3ry';
const OAUTH_CODE = 'oauth-CODE-SECRET-c0de';
const CLIENT_SECRET = 'client-SECRET-VALUE-s3cr';
const EMAIL = 'alice.sentry-marker@example.com';
const SQL_SECRET = 'SQL-LITERAL-SECRET';
const SQL = `SELECT * FROM "user" WHERE email = '${EMAIL}' AND password_hash = '${SQL_SECRET}'`;
const FRAGMENT = 'frag-SECRET-fr4g';

const SECRETS = [
  JWT,
  JWT_PAYLOAD,
  COOKIE_VALUE,
  PASSWORD,
  BODY_TOKEN,
  QUERY_TOKEN,
  OAUTH_CODE,
  CLIENT_SECRET,
  EMAIL,
  SQL_SECRET,
  FRAGMENT,
];

function expectNoSecrets(value: unknown): void {
  const serialised = JSON.stringify(value);
  for (const secret of SECRETS) {
    expect(serialised).not.toContain(secret);
  }
  expect(serialised.toLowerCase()).not.toContain('authorization":');
  expect(serialised.toLowerCase()).not.toContain('"cookie"');
}

const ENV = {
  SENTRY_DSN: 'https://publickey@sentry.example.invalid/1',
  NODE_ENV: 'production',
};

function options(env: Record<string, string | undefined> = ENV): NodeOptions {
  // Third argument: the boot-warning sink (silenced here; asserted in the S-8 block).
  const built = (
    buildSentryOptions as unknown as (
      e: Record<string, string | undefined>,
      o: Partial<NodeOptions>,
      warn: (message: string) => void,
    ) => NodeOptions | undefined
  )(env, {}, () => undefined);
  if (!built) throw new Error('expected options');
  return built;
}

const URL_WITH_SECRETS = `https://api.example.test/rest/v1/auth/callback?token=${QUERY_TOKEN}&code=${OAUTH_CODE}#${FRAGMENT}`;

function syntheticErrorEvent(url = URL_WITH_SECRETS): ErrorEvent {
  return {
    type: undefined,
    message: `login failed for ${EMAIL}`,
    exception: {
      values: [
        {
          type: 'UnauthorizedException',
          value: `bad credentials for ${EMAIL} with token=${QUERY_TOKEN} password=${PASSWORD} secret=${CLIENT_SECRET} code=${OAUTH_CODE} jwt ${JWT}`,
          stacktrace: {
            frames: [
              {
                filename: '/app/dist/main.js',
                function: 'bootstrap',
                lineno: 10,
                colno: 3,
                in_app: true,
              },
              {
                filename: '/app/dist/auth/auth.service.js',
                function: 'AuthService.login',
                lineno: 42,
                colno: 7,
                in_app: true,
              },
            ],
          },
          mechanism: { type: 'generic', handled: true },
        },
      ],
    },
    request: {
      method: 'POST',
      url,
      query_string: `token=${QUERY_TOKEN}&code=${OAUTH_CODE}`,
      cookies: { rab_session: COOKIE_VALUE },
      headers: {
        authorization: `Bearer ${JWT}`,
        cookie: COOKIE,
        'content-type': 'application/json',
      },
      data: { email: EMAIL, password: PASSWORD, token: BODY_TOKEN },
      env: { REMOTE_ADDR: '203.0.113.9' },
    },
    user: {
      id: 'user-1',
      email: EMAIL,
      ip_address: '203.0.113.9',
      username: EMAIL,
    },
    extra: {
      body: { password: PASSWORD, token: BODY_TOKEN },
      note: `Authorization: Bearer ${JWT}`,
      nested: {
        deeper: { clientSecret: CLIENT_SECRET, message: `mail ${EMAIL}` },
      },
    },
    tags: { 'login.email': EMAIL },
    transaction: `POST /rest/v1/auth/callback?token=${QUERY_TOKEN}`,
    breadcrumbs: [
      {
        category: 'http',
        type: 'http',
        data: {
          url: `https://idp.example.test/token?code=${OAUTH_CODE}#${FRAGMENT}`,
          'http.method': 'POST',
          'http.query': `code=${OAUTH_CODE}`,
          'http.fragment': FRAGMENT,
          status_code: 200,
        },
      },
      {
        category: 'console',
        level: 'log',
        message: `user ${EMAIL} sent password=${PASSWORD}`,
      },
    ],
  };
}

describe('instrument.ts — Sentry privacy options', () => {
  describe('buildSentryOptions', () => {
    it('returns undefined (no init) when SENTRY_DSN is unset or empty', () => {
      expect(buildSentryOptions({})).toBeUndefined();
      expect(buildSentryOptions({ SENTRY_DSN: '' })).toBeUndefined();
      expect(buildSentryOptions({ NODE_ENV: 'production' })).toBeUndefined();
    });

    it('turns default PII off and never enables local variables or extraErrorData', () => {
      const built = options();
      expect(built.sendDefaultPii).toBe(false);
      expect(built.includeLocalVariables).not.toBe(true);
      const names = (built.integrations as Integration[]).map(
        (integration) => integration.name,
      );
      expect(names).toContain('RequestData');
      expect(names).not.toContain('ExtraErrorData');
      expect(typeof built.beforeSend).toBe('function');
      expect(typeof built.beforeSendTransaction).toBe('function');
      expect(typeof built.beforeSendSpan).toBe('function');
      expect(typeof built.beforeBreadcrumb).toBe('function');
    });

    it('overrides cannot re-enable PII or replace the scrubbers', () => {
      const built = buildSentryOptions(ENV, {
        sendDefaultPii: true,
        beforeSend: (event) => event,
        integrations: [],
      } as Partial<NodeOptions>);
      expect(built?.sendDefaultPii).toBe(false);
      const event = built?.beforeSend?.(
        syntheticErrorEvent(),
        {},
      ) as ErrorEvent;
      expectNoSecrets(event);
      expect(
        (built?.integrations as Integration[]).map((i) => i.name),
      ).toContain('RequestData');
    });

    it('the RequestData integration attaches no cookies, headers, body, query string, IP or user', () => {
      const requestData = (options().integrations as Integration[]).find(
        (i) => i.name === 'RequestData',
      );
      const event: Event = {
        sdkProcessingMetadata: {
          normalizedRequest: {
            method: 'POST',
            url: `http://localhost:3000/rest/v1/auth/login?token=${QUERY_TOKEN}#${FRAGMENT}`,
            query_string: `token=${QUERY_TOKEN}`,
            headers: {
              authorization: `Bearer ${JWT}`,
              cookie: COOKIE,
              host: 'localhost:3000',
            },
            cookies: { rab_session: COOKIE_VALUE },
            data: JSON.stringify({ password: PASSWORD, token: BODY_TOKEN }),
          },
          request: { ip: '203.0.113.9', user: { id: 'u1', email: EMAIL } },
        },
      };
      const processed = requestData?.processEvent?.(
        event,
        {},
        {} as never,
      ) as Event;
      const { sdkProcessingMetadata: _metadata, ...egress } = processed;
      expect(egress.request?.headers).toBeUndefined();
      expect(egress.request?.cookies).toBeUndefined();
      expect(egress.request?.data).toBeUndefined();
      expect(egress.request?.query_string).toBeUndefined();
      expect(egress.user?.email).toBeUndefined();
      expect(egress.user?.ip_address).toBeUndefined();
      expect(egress.request?.method).toBe('POST');
      // The integration keeps the URL; `beforeSend` then strips the query string and fragment from it.
      const sent = options().beforeSend?.(
        egress as ErrorEvent,
        {},
      ) as ErrorEvent;
      expect(sent.request?.url).toBe(
        'http://localhost:3000/rest/v1/auth/login',
      );
      expectNoSecrets(sent);
    });
  });

  describe('tracesSampleRate', () => {
    it.each([
      [{ NODE_ENV: 'production' }, 0.01],
      [{ NODE_ENV: 'development' }, 0],
      [{ NODE_ENV: 'test' }, 0],
      [{}, 0],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '0.25' }, 0.25],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '0' }, 0],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '1' }, 1],
      [{ NODE_ENV: 'development', SENTRY_TRACES_SAMPLE_RATE: '.5' }, 0.5],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '1.5' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '-0.1' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: 'abc' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '   ' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '1e-1' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '0x1' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: 'Infinity' }, 0.01],
      [{ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: 'NaN' }, 0.01],
      [{ NODE_ENV: 'development', SENTRY_TRACES_SAMPLE_RATE: '2' }, 0],
    ])('%j → %d', (env, expected) => {
      expect(resolveTracesSampleRate(env)).toBe(expected);
      expect(
        options({ SENTRY_DSN: ENV.SENTRY_DSN, ...env }).tracesSampleRate,
      ).toBe(expected);
    });

    it('parseSampleRate is strict', () => {
      expect(parseSampleRate(undefined)).toBeUndefined();
      expect(parseSampleRate(' 0.3 ')).toBe(0.3);
      expect(parseSampleRate('1.0')).toBe(1);
      expect(parseSampleRate('+0.5')).toBeUndefined();
      expect(parseSampleRate('0.5abc')).toBeUndefined();
    });
  });

  describe('beforeSend (error events)', () => {
    it('removes cookies, headers, body, query string, fragment, emails, JWTs and token/code/password/secret values', () => {
      const sent = options().beforeSend?.(
        syntheticErrorEvent(),
        {},
      ) as ErrorEvent;
      expectNoSecrets(sent);
      expect(sent.request?.headers).toBeUndefined();
      expect(sent.request?.cookies).toBeUndefined();
      expect(sent.request?.data).toBeUndefined();
      expect(sent.request?.query_string).toBeUndefined();
      expect(sent.request?.env).toBeUndefined();
      expect(sent.request?.url).toBe(
        'https://api.example.test/rest/v1/auth/callback',
      );
      expect(sent.request?.method).toBe('POST');
      expect(sent.user).toEqual({ id: 'user-1' });
      expect(sent.transaction).toBe('POST /rest/v1/auth/callback');
    });

    it('keeps the error type and stack frames', () => {
      const sent = scrubErrorEvent(syntheticErrorEvent());
      const exception = sent.exception?.values?.[0];
      expect(exception?.type).toBe('UnauthorizedException');
      expect(exception?.value).toContain('bad credentials for');
      expect(exception?.stacktrace?.frames).toHaveLength(2);
      expect(exception?.stacktrace?.frames?.[1]).toMatchObject({
        filename: '/app/dist/auth/auth.service.js',
        function: 'AuthService.login',
        lineno: 42,
      });
      expect(exception?.mechanism).toEqual({ type: 'generic', handled: true });
    });

    it('still strips body, query string and cookies on AI routes (AI Phase 1 rule, now a subset)', () => {
      const sent = options().beforeSend?.(
        syntheticErrorEvent(
          `https://api.example.test/rest/v1/admin/ai/ask?token=${QUERY_TOKEN}`,
        ),
        {},
      ) as ErrorEvent;
      expect(sent.request?.data).toBeUndefined();
      expect(sent.request?.query_string).toBeUndefined();
      expect(sent.request?.cookies).toBeUndefined();
      expect(sent.request?.url).toBe(
        'https://api.example.test/rest/v1/admin/ai/ask',
      );
      expectNoSecrets(sent);
    });

    it('scrubs breadcrumbs that reached the event without passing beforeBreadcrumb (scope.addBreadcrumb)', () => {
      const sent = scrubErrorEvent(syntheticErrorEvent());
      expect(sent.breadcrumbs?.[0]?.data?.url).toBe(
        'https://idp.example.test/token',
      );
      expect(sent.breadcrumbs?.[0]?.data?.['http.query']).toBeUndefined();
      expect(sent.breadcrumbs?.[0]?.data?.['http.fragment']).toBeUndefined();
      expectNoSecrets(sent.breadcrumbs);
    });
  });

  describe('beforeSendTransaction + beforeSendSpan', () => {
    function syntheticTransaction(): TransactionEvent {
      return {
        type: 'transaction',
        transaction: `GET /rest/v1/shifts?token=${QUERY_TOKEN}`,
        request: {
          method: 'GET',
          url: URL_WITH_SECRETS,
          headers: { authorization: `Bearer ${JWT}`, cookie: COOKIE },
          cookies: { rab_session: COOKIE_VALUE },
          data: { password: PASSWORD, token: BODY_TOKEN },
          query_string: `token=${QUERY_TOKEN}`,
        },
        contexts: {
          trace: {
            trace_id: '0123456789abcdef0123456789abcdef',
            span_id: '0123456789abcdef',
            op: 'http.server',
            data: {
              'http.url': URL_WITH_SECRETS,
              'url.full': URL_WITH_SECRETS,
              'http.target': `/rest/v1/auth/callback?token=${QUERY_TOKEN}`,
              'url.query': `token=${QUERY_TOKEN}`,
              'http.request.header.authorization': [`Bearer ${JWT}`],
              'http.request.header.cookie': [COOKIE],
              'net.peer.ip': '203.0.113.9',
              'http.method': 'GET',
              'http.status_code': 500,
            },
          },
        },
        spans: [
          {
            span_id: '1111111111111111',
            trace_id: '0123456789abcdef0123456789abcdef',
            start_timestamp: 1,
            op: 'db',
            description: SQL,
            data: {
              'db.system': 'postgresql',
              'db.statement': SQL,
              'db.name': 'rab',
            },
          },
          {
            span_id: '2222222222222222',
            trace_id: '0123456789abcdef0123456789abcdef',
            start_timestamp: 1,
            op: 'http.client',
            description: `GET https://idp.example.test/userinfo?access_token=${QUERY_TOKEN}`,
            data: {
              'http.url': `https://idp.example.test/userinfo?access_token=${QUERY_TOKEN}`,
              'http.query': `access_token=${QUERY_TOKEN}`,
            },
          },
        ],
      } as TransactionEvent;
    }

    it('scrubs the transaction request, root-span attributes and every child span', () => {
      const built = options();
      const transaction = syntheticTransaction();
      // Sentry runs beforeSendSpan over child spans, then beforeSendTransaction over the whole event.
      transaction.spans = transaction.spans?.map(
        (span) => built.beforeSendSpan?.(span) as SpanJSON,
      );
      const sent = built.beforeSendTransaction?.(
        transaction,
        {},
      ) as TransactionEvent;
      expectNoSecrets(sent);
      expect(sent.request?.headers).toBeUndefined();
      expect(sent.request?.url).toBe(
        'https://api.example.test/rest/v1/auth/callback',
      );
      const rootData = sent.contexts?.trace?.data as Record<string, unknown>;
      expect(rootData['http.url']).toBe(
        'https://api.example.test/rest/v1/auth/callback',
      );
      expect(rootData['http.target']).toBe('/rest/v1/auth/callback');
      expect(rootData['url.query']).toBeUndefined();
      expect(rootData['net.peer.ip']).toBeUndefined();
      expect(rootData['http.method']).toBe('GET');
      expect(rootData['http.status_code']).toBe(500);
      expect(sent.transaction).toBe('GET /rest/v1/shifts');
    });

    it('beforeSendTransaction alone (no beforeSendSpan) still scrubs child spans', () => {
      const sent = scrubTransactionEvent(syntheticTransaction());
      expectNoSecrets(sent);
    });

    it('drops db.statement and reduces the SQL description to a fixed placeholder', () => {
      const span = scrubSpan({
        span_id: '1',
        trace_id: '2',
        start_timestamp: 1,
        op: 'db',
        description: SQL,
        data: { 'db.system': 'postgresql', 'db.statement': SQL },
      } as SpanJSON);
      expect(span.data?.['db.statement']).toBeUndefined();
      expect(span.data?.['db.system']).toBe('postgresql');
      expect(span.description).toBe('SELECT [Filtered]');
      expectNoSecrets(span);
    });

    it('strips the query string from URL span attributes and descriptions', () => {
      const span = options().beforeSendSpan?.({
        span_id: '1',
        trace_id: '2',
        start_timestamp: 1,
        op: 'http.client',
        description: `POST https://idp.example.test/token?code=${OAUTH_CODE}#${FRAGMENT}`,
        data: {
          'url.full': `https://idp.example.test/token?code=${OAUTH_CODE}`,
          'http.url': `https://idp.example.test/token?code=${OAUTH_CODE}`,
          'http.target': `/token?code=${OAUTH_CODE}`,
          'url.query': `code=${OAUTH_CODE}`,
          'url.fragment': FRAGMENT,
          'http.query': `?code=${OAUTH_CODE}`,
          'http.fragment': `#${FRAGMENT}`,
        },
      } as SpanJSON) as SpanJSON;
      expect(span.description).toBe('POST https://idp.example.test/token');
      expect(span.data).toEqual({
        'url.full': 'https://idp.example.test/token',
        'http.url': 'https://idp.example.test/token',
        'http.target': '/token',
      });
      expectNoSecrets(span);
    });
  });

  describe('beforeBreadcrumb', () => {
    it('removes http.query / http.fragment and the query string from outgoing-request breadcrumbs', () => {
      const crumb = options().beforeBreadcrumb?.(
        {
          category: 'http',
          type: 'http',
          data: {
            url: `https://idp.example.test/token?code=${OAUTH_CODE}`,
            'http.method': 'POST',
            'http.query': `code=${OAUTH_CODE}`,
            'http.fragment': FRAGMENT,
            status_code: 200,
          },
        },
        {},
      ) as Breadcrumb;
      expect(crumb.data).toEqual({
        url: 'https://idp.example.test/token',
        'http.method': 'POST',
        status_code: 200,
      });
    });

    it('redacts emails, JWTs, bearer tokens and secrets in console breadcrumb messages and data', () => {
      const crumb = scrubBreadcrumb({
        category: 'console',
        level: 'warning',
        message: `login ${EMAIL} Authorization: Bearer ${JWT} password=${PASSWORD} token=${BODY_TOKEN}`,
        data: {
          arguments: [
            `login ${EMAIL}`,
            { password: PASSWORD, token: BODY_TOKEN, jwt: JWT },
          ],
          logger: 'console',
        },
      }) as Breadcrumb;
      expectNoSecrets(crumb);
      expect(crumb.message).toContain('login');
      expect(crumb.data?.logger).toBe('console');
    });
  });

  describe('redactString / stripUrlQueryAndFragment', () => {
    it.each([
      [`token=${QUERY_TOKEN}`, 'token=[Filtered]'],
      [`code=${OAUTH_CODE}&x=1`, 'code=[Filtered]&x=1'],
      [`password=${PASSWORD}`, 'password=[Filtered]'],
      [`client_secret=${CLIENT_SECRET}`, 'client_secret=[Filtered]'],
      [`secret=${CLIENT_SECRET}`, 'secret=[Filtered]'],
      [
        `{"password":"${PASSWORD}","ok":true}`,
        '{"password":"[Filtered]","ok":true}',
      ],
      [`Bearer ${BODY_TOKEN}`, 'Bearer [Filtered]'],
      [`jwt ${JWT} end`, 'jwt [Filtered] end'],
      [`mail ${EMAIL}!`, 'mail [Filtered]!'],
      [`Cookie: ${COOKIE}`, 'Cookie: [Filtered]'],
    ])('%s', (input, expected) => {
      expect(redactString(input)).toBe(expected);
      expect(redactString(redactString(input))).toBe(expected);
    });

    it('leaves ordinary diagnostic text alone', () => {
      const text =
        'InvalidTransitionError: cannot publishShift from CANCELLED (statusCode 409)';
      expect(redactString(text)).toBe(text);
    });

    it('strips query, fragment and userinfo from URLs', () => {
      expect(
        stripUrlQueryAndFragment(
          `https://user:${PASSWORD}@host.test/a/b?token=${QUERY_TOKEN}#${FRAGMENT}`,
        ),
      ).toBe('https://host.test/a/b');
      expect(stripUrlQueryAndFragment(`/rest/v1/x?token=${QUERY_TOKEN}`)).toBe(
        '/rest/v1/x',
      );
      expect(stripUrlQueryAndFragment('/rest/v1/x')).toBe('/rest/v1/x');
    });
  });

  // Security review S-5: one row per redaction gap.
  describe('redaction gaps (S-5)', () => {
    it.each([
      // 1. userinfo anywhere in free text, any scheme, IP hosts
      [
        'pg connect failed: postgres://crewflow:pg-PASS-s3cr@10.0.0.5:5432/rab (timeout)',
        'pg connect failed: postgres://10.0.0.5:5432/rab (timeout)',
      ],
      [
        'fetch https://svc:svc-PASS-s3cr@api.example.test/v1 failed',
        'fetch https://api.example.test/v1 failed',
      ],
      // 2. quoted values after `:` and `=`
      ["password: 'quoted-PASS-s3cr'", 'password: [Filtered]'],
      ['token: "quoted-TOKEN-s3cr"', 'token: [Filtered]'],
      ['password="quoted PASS s3cr"', 'password=[Filtered]'],
      ["secret='quoted-SECRET-s3cr' next", 'secret=[Filtered] next'],
      // 3. a truncated JWT (header + part of the payload)
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1 cut', 'jwt [Filtered] cut'],
      ['header only eyJhbGciOiJIUzI1NiJ9', 'header only [Filtered]'],
    ])('redactString(%j)', (input, expected) => {
      expect(redactString(input)).toBe(expected);
      expect(redactString(redactString(input))).toBe(expected);
    });

    it.each([
      ['password_hash'],
      ['passwordHash'],
      ['oldPassword'],
      ['new_password_confirmation'],
    ])('scrubData filters the %s key', (key) => {
      const out = instrument.scrubData({ [key]: 'HASH-VALUE-s3cr', keep: 1 });
      expect(out).toEqual({ [key]: '[Filtered]', keep: 1 });
    });
  });

  // Security review S-1: every string is capped before any regex runs and every pattern is linear. Each case runs in a
  // child process so a super-linear regex in the version under test times out instead of hanging this Jest worker.
  describe('redaction cost is bounded (S-1)', () => {
    const PERF_TIMEOUT_MS = 15_000;

    function runPerfCase(
      caseName: string,
    ): Promise<{ ms?: number; timedOut: boolean; output: string }> {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } =
        require('child_process') as typeof import('child_process');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { join } = require('path') as typeof import('path');
      const serverDir = join(__dirname, '..');
      const program = `
require(${JSON.stringify(require.resolve('ts-node', { paths: [serverDir] }))}).register({
  transpileOnly: true,
  project: ${JSON.stringify(join(serverDir, 'tsconfig.app.json'))},
});
const m = require(${JSON.stringify(join(__dirname, 'instrument.ts'))});
const name = process.env.PERF_CASE;
m.redactString('warm up token=x a@b.co'); // compile the regexes outside the measured window
const path16k = '/' + 'a-'.repeat(2731) + 'a.'.repeat(2731) + 'a@'.repeat(2731);
const url16k = 'https://api.example.test' + path16k;
const inputs = {
  'a': () => 'a'.repeat(100000),
  'a-': () => 'a-'.repeat(50000),
  'a.': () => 'a.'.repeat(50000),
  'a@': () => 'a@'.repeat(50000),
};
let run;
if (name === 'transaction-16k') {
  const event = {
    type: 'transaction',
    transaction: 'GET ' + path16k,
    contexts: { trace: { trace_id: '0'.repeat(32), span_id: '0'.repeat(16), op: 'http.server',
      data: { 'http.url': url16k, 'http.target': path16k, 'url.full': url16k, 'url.path': path16k } } },
    spans: [{ span_id: '1'.repeat(16), trace_id: '0'.repeat(32), start_timestamp: 1, op: 'http.client',
      description: 'GET ' + url16k, data: { 'http.url': url16k, 'url.full': url16k, 'http.target': path16k } }],
  };
  run = () => m.scrubTransactionEvent(event);
} else {
  const input = inputs[name]();
  run = () => m.redactString(input);
}
const start = process.hrtime.bigint();
run();
const ms = Number(process.hrtime.bigint() - start) / 1e6;
process.stdout.write(JSON.stringify({ ms }));
`;
      const env: NodeJS.ProcessEnv = { ...process.env, PERF_CASE: caseName };
      delete env.SENTRY_DSN;
      return new Promise((resolve, reject) => {
        let output = '';
        const child = spawn(process.execPath, ['-e', program], {
          cwd: serverDir,
          env,
          stdio: 'pipe',
        });
        child.stdout.on('data', (c: Buffer) => (output += c.toString()));
        child.stderr.on('data', (c: Buffer) => (output += c.toString()));
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, PERF_TIMEOUT_MS);
        child.on('error', reject);
        child.on('exit', () => {
          clearTimeout(timer);
          if (timedOut) return resolve({ timedOut, output });
          try {
            resolve({
              ms: (JSON.parse(output) as { ms: number }).ms,
              timedOut,
              output,
            });
          } catch {
            resolve({ timedOut, output });
          }
        });
      });
    }

    it.each([
      ['a', 50],
      ['a-', 50],
      ['a.', 50],
      ['a@', 50],
      ['transaction-16k', 100],
    ])(
      '%s finishes within %d ms',
      async (caseName, budgetMs) => {
        const result = await runPerfCase(caseName as string);
        expect({
          timedOut: result.timedOut,
          parsed: result.ms !== undefined,
        }).toEqual({
          timedOut: false,
          parsed: true,
        });
        expect(result.ms).toBeLessThan(budgetMs as number);
      },
      PERF_TIMEOUT_MS + 15_000,
    );

    it('caps every string at about 2048 characters and never leaves a partial token at the cut', () => {
      const longValue = `${'word '.repeat(500)}${JWT}`;
      const out = redactString(longValue);
      expect(out.length).toBeLessThanOrEqual(2049);
      expect(out.endsWith('…')).toBe(true);
      expectNoSecrets(out);
      expect(out).not.toContain('eyJ');
    });
  });

  // Security review S-4: a scrubber that throws drops the event/breadcrumb instead of sending it unscrubbed.
  describe('hooks fail closed (S-4)', () => {
    function throwingGetter<T extends object>(target: T, key: string): T {
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          throw new Error('forced scrubber failure');
        },
      });
      return target;
    }

    it('beforeSend returns null when scrubbing throws', () => {
      const event = syntheticErrorEvent();
      throwingGetter(event.request as object, 'url');
      expect(options().beforeSend?.(event, {})).toBeNull();
    });

    it('beforeSendTransaction returns null when scrubbing throws', () => {
      const event = {
        type: 'transaction',
        spans: [],
      } as unknown as TransactionEvent;
      throwingGetter(event as object, 'request');
      expect(options().beforeSendTransaction?.(event, {})).toBeNull();
    });

    it('beforeSendSpan returns the span with empty data and a filtered description when scrubbing throws', () => {
      const span = {
        span_id: '1',
        trace_id: '2',
        start_timestamp: 1,
        op: 'db',
        description: SQL,
      } as SpanJSON;
      throwingGetter(span, 'data');
      const out = options().beforeSendSpan?.(span) as SpanJSON;
      expect(out.data).toEqual({});
      expect(out.description).toBe('[Filtered]');
      expect(out.span_id).toBe('1');
      expectNoSecrets({ description: out.description, data: out.data });
    });

    it('beforeBreadcrumb drops the breadcrumb when scrubbing throws', () => {
      const crumb = throwingGetter(
        { category: 'console' } as Breadcrumb,
        'message',
      );
      expect(options().beforeBreadcrumb?.(crumb, {})).toBeNull();
    });
  });

  // Security review S-8: an invalid SENTRY_TRACES_SAMPLE_RATE logs one boot warning that never echoes the value.
  describe('invalid SENTRY_TRACES_SAMPLE_RATE warning (S-8)', () => {
    const build = buildSentryOptions as unknown as (
      env: Record<string, string | undefined>,
      overrides?: Partial<NodeOptions>,
      warn?: (message: string) => void,
    ) => NodeOptions | undefined;

    it('warns exactly once, without the value, and falls back', () => {
      const warn = jest.fn();
      const built = build(
        { ...ENV, SENTRY_TRACES_SAMPLE_RATE: 'oops-RATE-VALUE-7' },
        {},
        warn,
      );
      expect(built?.tracesSampleRate).toBe(0.01);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        'SENTRY_TRACES_SAMPLE_RATE',
      );
      expect(String(warn.mock.calls[0][0])).not.toContain('oops-RATE-VALUE-7');
    });

    it.each([[undefined], [''], ['0.2']])('does not warn for %j', (value) => {
      const warn = jest.fn();
      build({ ...ENV, SENTRY_TRACES_SAMPLE_RATE: value }, {}, warn);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
