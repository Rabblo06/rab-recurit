/**
 * Phase 0 "Sentry": end-to-end egress check for `instrument.ts`.
 *
 * A child Node process loads the real `instrument.ts` first (as every entrypoint does), with `SENTRY_DSN` pointing at a
 * stub Sentry ingest server in this process and tracing forced on. The child then serves a request carrying a Cookie,
 * an `Authorization: Bearer <JWT>` header, a `{password, token}` JSON body and a `?token=` query string, makes an
 * outgoing request with `?code=`, logs an email to the console, records a DB span with SQL text, throws, captures the
 * error and flushes. Every envelope the real Sentry transport delivers is captured here and searched for each secret.
 */
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';

delete process.env.SENTRY_DSN; // importing instrument.ts must never initialise Sentry in this (parent) process
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ALLOWED_DEFAULT_INTEGRATIONS } =
  require('./instrument') as typeof import('./instrument');

const SERVER_DIR = join(__dirname, '..');
const INSTRUMENT = join(__dirname, 'instrument.ts');
const TSCONFIG = join(SERVER_DIR, 'tsconfig.app.json');

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlbnZlbG9wZS1qd3QtbWFya2VyIn0.c2lnLWVudmVsb3BlLWp3dC1zaWduYXR1cmU';
const JWT_PAYLOAD = 'eyJzdWIiOiJlbnZlbG9wZS1qd3QtbWFya2VyIn0';
const SECRETS = {
  jwt: JWT,
  jwtPayload: JWT_PAYLOAD,
  cookie: 'envelope-COOKIE-SECRET-c00k',
  password: 'envelope-PASSWORD-SECRET-pw',
  bodyToken: 'envelope-BODY-TOKEN-SECRET-bt',
  queryToken: 'envelope-QUERY-TOKEN-SECRET-qt',
  oauthCode: 'envelope-OAUTH-CODE-SECRET-oc',
  fragment: 'envelope-FRAGMENT-SECRET-fr',
  email: 'bob.envelope-marker@example.com',
  sqlLiteral: 'envelope-SQL-LITERAL-SECRET',
  failClosed: 'envelope-FAILCLOSED-SECRET-fc',
  // H4b: headers Sentry 10's own deny lists keep (they only match auth/token/session/cookie-like names), so they reach
  // its http.server span attributes and only this file's scrubber stands between them and the envelope.
  headerProbe: 'envelope-CUSTOM-HEADER-SECRET-hp',
  refererToken: 'envelope-REFERER-TOKEN-SECRET-rt',
};

/**
 * Every integration name Sentry 8.55 or 10.x installs by default, plus the ones this file must never see. The child
 * reports which of them its real client has installed.
 */
const FORBIDDEN_INTEGRATIONS = [
  'Anthropic_AI',
  'ConversationId',
  'ExtraErrorData',
  'Firebase',
  'Google_GenAI',
  'Hono',
  'LangChain',
  'LangGraph',
  'LocalVariables',
  'Nest',
  'NodeSystemError',
  'OpenAI',
  'PostgresJs',
  'Prisma',
  'ProcessAndThreadBreadcrumbs',
  'ProcessSession',
  'VercelAI',
  'vercelAI',
];
const INTEGRATION_CANDIDATES = [
  ...ALLOWED_DEFAULT_INTEGRATIONS,
  'RequestData',
  ...FORBIDDEN_INTEGRATIONS,
];

/** Every variable @sentry/node-core 10.78 `getSentryRelease()` reads to infer a release. */
const RELEASE_ENV_VARS = [
  'SENTRY_RELEASE',
  'GITHUB_SHA',
  'CI_MERGE_REQUEST_SOURCE_BRANCH_SHA',
  'CI_BUILD_REF',
  'CI_COMMIT_SHA',
  'BITBUCKET_COMMIT',
  'APPVEYOR_PULL_REQUEST_HEAD_COMMIT',
  'APPVEYOR_REPO_COMMIT',
  'CODEBUILD_RESOLVED_SOURCE_VERSION',
  'AWS_COMMIT_ID',
  'BUILD_SOURCEVERSION',
  'GIT_CLONE_COMMIT_HASH',
  'BUDDY_EXECUTION_REVISION',
  'BUILDKITE_COMMIT',
  'CIRCLE_SHA1',
  'CIRRUS_CHANGE_IN_REPO',
  'CF_REVISION',
  'CM_COMMIT',
  'CF_PAGES_COMMIT_SHA',
  'DRONE_COMMIT_SHA',
  'FC_GIT_COMMIT_SHA',
  'HEROKU_TEST_RUN_COMMIT_VERSION',
  'HEROKU_SLUG_COMMIT',
  'HEROKU_BUILD_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'SEMAPHORE_GIT_SHA',
  'TRAVIS_PULL_REQUEST_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GITHUB_COMMIT_SHA',
  'VERCEL_GITLAB_COMMIT_SHA',
  'VERCEL_BITBUCKET_COMMIT_SHA',
  'ZEIT_GITHUB_COMMIT_SHA',
  'ZEIT_GITLAB_COMMIT_SHA',
  'ZEIT_BITBUCKET_COMMIT_SHA',
  'CI_COMMIT_ID',
  'SOURCE_COMMIT',
  'SOURCE_VERSION',
  'GIT_COMMIT',
  'COMMIT_REF',
  'BUILD_VCS_NUMBER',
];

/** The child program (CommonJS). `instrument.ts` is required before `http`, exactly like the real entrypoints. */
function childProgram(): string {
  return `
require(${JSON.stringify(require.resolve('ts-node', { paths: [SERVER_DIR] }))}).register({
  transpileOnly: true,
  project: ${JSON.stringify(TSCONFIG)},
});
require(${JSON.stringify(INSTRUMENT)});
const Sentry = require(${JSON.stringify(require.resolve('@sentry/node', { paths: [SERVER_DIR] }))});
const http = require('http');
const S = JSON.parse(process.env.ENVELOPE_TEST_SECRETS);

// H4b: what the real Sentry.init (not just buildSentryOptions) ended up with, for the parent to assert.
{
  const client = Sentry.getClient();
  const o = client.getOptions();
  const candidates = JSON.parse(process.env.ENVELOPE_TEST_INTEGRATION_CANDIDATES);
  require('fs').writeFileSync(process.env.ENVELOPE_TEST_REPORT, JSON.stringify({
    sdkVersion: Sentry.SDK_VERSION,
    installed: candidates.filter((name) => client.getIntegrationByName(name) !== undefined),
    // Every integration the client actually set up, whatever its name (catches one added outside \`integrations\`).
    installedAll: Object.keys(client._integrations || {}),
    options: {
      sendDefaultPii: o.sendDefaultPii,
      includeLocalVariables: o.includeLocalVariables,
      enableLogs: o.enableLogs,
      enableMetrics: o.enableMetrics,
      tracesSampleRate: o.tracesSampleRate,
      profilesSampleRate: o.profilesSampleRate === undefined ? null : o.profilesSampleRate,
      release: o.release === undefined ? null : o.release,
      spotlight: o.spotlight === undefined ? null : o.spotlight,
      debug: o.debug === undefined ? null : o.debug,
    },
    dataCollection: client.getDataCollectionOptions(),
  }));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url.startsWith('/outgoing')) { res.end('ok'); return; }
    console.log('processing login for ' + S.email + ' token=' + S.bodyToken);
    Sentry.addBreadcrumb({ category: 'auth', message: 'attempt ' + S.email + ' password=' + S.password, data: { password: S.password } });
    Sentry.getIsolationScope().setExtra('payload', JSON.parse(body));
    Sentry.startSpan(
      { name: "SELECT * FROM \\"user\\" WHERE email = '" + S.email + "' AND hash = '" + S.sqlLiteral + "'", op: 'db',
        attributes: { 'db.system': 'postgresql', 'db.statement': "SELECT * FROM \\"user\\" WHERE email = '" + S.email + "' AND hash = '" + S.sqlLiteral + "'" } },
      () => undefined,
    );
    const port = server.address().port;
    http.get('http://localhost:' + port + '/outgoing?code=' + S.oauthCode + '#' + S.fragment, (out) => {
      out.resume();
      out.on('end', () => {
        try {
          throw new Error('login failed for ' + S.email + ' token=' + S.queryToken + ' jwt ' + S.jwt);
        } catch (err) {
          Sentry.captureException(err);
        }
        // S-4 probe: a scope processor (runs after RequestData, before beforeSend) plants an unscrubbed secret in
        // \`extra\` and makes the scrubber throw on its first read of request.url. A fail-open hook would send the
        // planted secret; a fail-closed hook drops the whole event.
        Sentry.withScope((scope) => {
          scope.addEventProcessor((ev) => {
            ev.extra = Object.assign({}, ev.extra, { leak: S.failClosed + ' password=' + S.password });
            ev.request = ev.request || {};
            let reads = 0;
            Object.defineProperty(ev.request, 'url', {
              enumerable: true,
              configurable: true,
              get() {
                if (reads++ === 0) throw new Error('forced scrubber failure');
                return 'http://localhost/fail-closed';
              },
            });
            return ev;
          });
          Sentry.captureException(new Error('fail-closed probe'));
        });
        res.statusCode = 500;
        res.end('error');
      });
    });
  });
});

server.listen(0, () => {
  const port = server.address().port;
  const payload = JSON.stringify({ email: S.email, password: S.password, token: S.bodyToken });
  const req = http.request(
    {
      host: 'localhost',
      port,
      method: 'POST',
      path: '/rest/v1/auth/login?token=' + S.queryToken + '&code=' + S.oauthCode,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: 'Bearer ' + S.jwt,
        cookie: 'rab_session=' + S.cookie,
        'x-forwarded-for': '203.0.113.77',
        'x-rab-probe': S.headerProbe,
        referer: 'https://app.example.test/page?invite=' + S.refererToken,
      },
    },
    (res) => {
      res.resume();
      res.on('end', () => {
        setTimeout(async () => {
          await Sentry.flush(10000);
          server.close();
          process.exit(0);
        }, 1000);
      });
    },
  );
  req.end(payload);
});
`;
}

interface Envelope {
  raw: string;
  items: Array<{ header: Record<string, unknown>; payload: unknown }>;
}

function parseEnvelope(raw: string): Envelope {
  const lines = raw.split('\n').filter((line) => line.length > 0);
  const items: Envelope['items'] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const header = JSON.parse(lines[i]) as Record<string, unknown>;
    let payload: unknown = lines[i + 1];
    try {
      payload = JSON.parse(lines[i + 1]);
    } catch {
      // non-JSON item payload (attachments) — keep raw text for the secret scan
    }
    items.push({ header, payload });
  }
  return { raw, items };
}

describe('instrument.ts — real Sentry envelopes contain no request secrets', () => {
  let ingest: Server;
  const envelopes: Envelope[] = [];
  let childOutput = '';
  let childExitCode: number | null = null;
  let report: Record<string, any> = {};
  // Requests that reached the Spotlight sidecar path (SENTRY_SPOTLIGHT points at this stub): must stay 0.
  let spotlightRequests = 0;

  beforeAll(async () => {
    ingest = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if ((req.url ?? '').startsWith('/spotlight')) {
          spotlightRequests += 1;
          res.end('{}');
          return;
        }
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
        envelopes.push(parseEnvelope(body.toString('utf8')));
        res.statusCode = 200;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      ingest.listen(0, '127.0.0.1', resolve),
    );
    const { port } = ingest.address() as AddressInfo;
    const reportDir = mkdtempSync(join(tmpdir(), 'sentry-envelope-'));
    const reportFile = join(reportDir, 'report.json');

    // A local stub DSN, not a real one: the public key is a placeholder and the host is this test's own server.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SENTRY_DSN: `http://stubpublickey@127.0.0.1:${port}/1`,
      NODE_ENV: 'production',
      SENTRY_TRACES_SAMPLE_RATE: '1',
      ENVELOPE_TEST_SECRETS: JSON.stringify(SECRETS),
      ENVELOPE_TEST_REPORT: reportFile,
      // F5: an operator or platform env asking for Spotlight / SDK debug logging must change nothing.
      SENTRY_SPOTLIGHT: `http://127.0.0.1:${port}/spotlight/stream`,
      SENTRY_DEBUG: 'true',
      ENVELOPE_TEST_INTEGRATION_CANDIDATES: JSON.stringify(
        INTEGRATION_CANDIDATES,
      ),
    };
    delete env.JEST_WORKER_ID;
    // No release: Sentry infers one from CI/platform commit variables (GITHUB_SHA on Actions), and with a release the
    // allowed Http integration also sends request-session counts, exactly as Sentry 8 did (THREAT-MODEL.md, H4b). This
    // run asserts the release-less item set; the list is @sentry/node-core 10.78's getSentryRelease() lookup.
    for (const name of RELEASE_ENV_VARS) delete env[name];

    childExitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', childProgram()], {
        cwd: SERVER_DIR,
        env,
        stdio: 'pipe',
      });
      child.stdout.on(
        'data',
        (chunk: Buffer) => (childOutput += chunk.toString()),
      );
      child.stderr.on(
        'data',
        (chunk: Buffer) => (childOutput += chunk.toString()),
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`child timed out:\n${childOutput}`));
      }, 60_000);
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<
        string,
        any
      >;
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => ingest.close(() => resolve()));
  });

  function itemsOfType(type: string): Array<Record<string, any>> {
    return envelopes.flatMap((envelope) =>
      envelope.items
        .filter((item) => item.header.type === type)
        .map((item) => item.payload as Record<string, any>),
    );
  }

  it('the child ran and delivered an error event through the real transport', () => {
    expect({
      childExitCode,
      childOutput: childExitCode === 0 ? '' : childOutput,
    }).toEqual({
      childExitCode: 0,
      childOutput: '',
    });
    expect(itemsOfType('event').length).toBeGreaterThanOrEqual(1);
  });

  it('no captured envelope contains a cookie, Authorization header, body, query token, email, JWT or SQL literal', () => {
    expect(envelopes.length).toBeGreaterThan(0);
    const all = envelopes.map((envelope) => envelope.raw).join('\n');
    const leaked = Object.entries(SECRETS)
      .filter(([, secret]) => all.includes(secret))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
    expect(all.toLowerCase()).not.toMatch(/"authorization"\s*:/);
    expect(all.toLowerCase()).not.toMatch(/"cookie"\s*:/);
    expect(all).not.toContain('203.0.113.77');
  });

  it('an event whose scrubber throws is dropped, never sent unscrubbed (S-4)', () => {
    const probes = itemsOfType('event').filter((event) =>
      JSON.stringify(event.exception ?? {}).includes('fail-closed probe'),
    );
    expect(probes).toEqual([]);
    const all = envelopes.map((envelope) => envelope.raw).join('\n');
    expect(all).not.toContain(SECRETS.failClosed);
  });

  it('the error event keeps its type and stack frames but has no headers, cookies, body or query string', () => {
    const event =
      itemsOfType('event').find((e) =>
        JSON.stringify(e.exception ?? {}).includes('login failed'),
      ) ?? {};
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.url).toMatch(/\/rest\/v1\/auth\/login$/);
    const exception = event.exception?.values?.[0];
    expect(exception?.type).toBe('Error');
    expect(exception?.value).toContain('login failed for');
    expect(exception?.stacktrace?.frames?.length).toBeGreaterThan(0);
  });

  it('the transaction is sampled, scrubbed and its DB span carries no SQL text', () => {
    const transactions = itemsOfType('transaction');
    expect(transactions.length).toBeGreaterThanOrEqual(1);
    const loginTransaction = transactions.find((t) =>
      /auth\/login/.test(JSON.stringify(t.contexts?.trace?.data ?? {})),
    );
    expect(loginTransaction).toBeDefined();
    const rootData = loginTransaction?.contexts?.trace?.data ?? {};
    for (const key of ['http.url', 'url.full', 'http.target']) {
      if (key in rootData) expect(rootData[key]).not.toContain('?');
    }
    const dbSpans = (loginTransaction?.spans ?? []).filter(
      (span: Record<string, any>) => span.op === 'db',
    );
    expect(dbSpans.length).toBeGreaterThanOrEqual(1);
    for (const span of dbSpans) {
      expect(span.data?.['db.statement']).toBeUndefined();
      expect(span.description).toBe('SELECT [Filtered]');
    }
  });

  it('the real client runs exactly the allowed default integrations plus the restricted RequestData (H4b)', () => {
    const expected = [...ALLOWED_DEFAULT_INTEGRATIONS, 'RequestData'].sort();
    expect([...(report.installed as string[])].sort()).toEqual(expected);
    // The full set the client set up, not just the names this file thought to ask about.
    expect([...new Set(report.installedAll as string[])].sort()).toEqual(
      expected,
    );
  });

  it('the real client keeps PII, local variables, logs and profiling off; tracing only as configured (H4b)', () => {
    expect(report.sdkVersion).toMatch(/^10\./);
    expect(report.options).toEqual({
      sendDefaultPii: false,
      includeLocalVariables: false,
      enableLogs: false,
      enableMetrics: false,
      tracesSampleRate: 1, // forced by this test through SENTRY_TRACES_SAMPLE_RATE; production default is 0.01
      profilesSampleRate: null,
      release: null, // see RELEASE_ENV_VARS: a new inferred-release variable fails here, not in the item-type check
      spotlight: false, // despite SENTRY_SPOTLIGHT in the child's environment
      debug: false, // despite SENTRY_DEBUG=true
    });
    // Sentry 10 derives its data-collection categories from sendDefaultPii: false (the restrictive legacy mapping).
    expect(report.dataCollection).toMatchObject({
      userInfo: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
    });
  });

  it('request headers Sentry 10 itself keeps never reach an envelope (H4b: the http.server span adds them)', () => {
    const all = envelopes.map((envelope) => envelope.raw).join('\n');
    expect(all).not.toContain(SECRETS.headerProbe);
    expect(all).not.toContain(SECRETS.refererToken);
    expect(all).not.toContain('http.request.header.');
  });

  it('SENTRY_SPOTLIGHT adds no Spotlight integration and sends nothing to its sidecar URL (H4b, review F5)', () => {
    expect(report.installedAll as string[]).not.toContain('Spotlight');
    expect(spotlightRequests).toBe(0);
  });

  // Sessions: like Sentry 8, the allowed Http integration records request sessions, which Sentry sends only when a
  // release is configured (SENTRY_RELEASE or an auto-detected commit variable). This run sets none; the assertion is
  // that the upgrade adds no other item type (logs, metrics, profiles, check-ins, replays).
  it('only error events, transactions and client reports leave the process: no logs, metrics or profiles (H4b)', () => {
    const types = new Set(
      envelopes.flatMap((envelope) =>
        envelope.items.map((item) => String(item.header.type)),
      ),
    );
    for (const type of types)
      expect(['event', 'transaction', 'client_report']).toContain(type);
  });
});
