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
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { gunzipSync } from 'zlib';

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
};

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

  beforeAll(async () => {
    ingest = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
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

    // A local stub DSN, not a real one: the public key is a placeholder and the host is this test's own server.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SENTRY_DSN: `http://stubpublickey@127.0.0.1:${port}/1`,
      NODE_ENV: 'production',
      SENTRY_TRACES_SAMPLE_RATE: '1',
      ENVELOPE_TEST_SECRETS: JSON.stringify(SECRETS),
    };
    delete env.JEST_WORKER_ID;

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
});
