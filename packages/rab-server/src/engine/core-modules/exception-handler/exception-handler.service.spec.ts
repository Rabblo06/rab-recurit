/**
 * Phase X3.2: the exception handler (Twenty's exception-handler module, re-implemented) and its Sentry egress.
 *
 * The egress cases run the REAL path — AllExceptionsFilter's 500 branch → ExceptionHandlerService → the Sentry driver →
 * `Sentry.captureException` → the `beforeSend` hook that `instrument.ts` builds → the transport — on a Sentry client
 * whose transport records every envelope in memory instead of sending it. Every synthetic secret is a unique marker, so a
 * leak anywhere in the serialised envelope is detected.
 */
import { ArgumentsHost, HttpStatus, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/node';

import { AllExceptionsFilter } from '../../filters/all-exceptions.filter';
import { ExceptionHandlerNoopDriver } from './drivers/noop.driver';
import { ExceptionHandlerSentryDriver, SentryCaptureApi } from './drivers/sentry.driver';
import { createExceptionHandlerDriver } from './exception-handler-driver.factory';
import { ExceptionHandlerService, shouldCaptureException } from './exception-handler.service';

delete process.env.SENTRY_DSN; // importing instrument.ts must never initialise Sentry in this process
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildSentryOptions } = require('../../../instrument') as typeof import('../../../instrument');

/** The shape of a captured envelope: [headers, [[itemHeader, payload], …]]. */
type Envelope = [Record<string, unknown>, Array<[{ type?: string }, unknown]>];

const DSN = 'https://publickey@sentry.example.test/1';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4MzItc2VudHJ5LWp3dC1tYXJrZXIifQ.eDMyLXNlbnRyeS1qd3Qtc2lnbmF0dXJl'; // gitleaks:allow (synthetic scrubber marker, not a credential)
const SECRETS = {
  jwt: JWT,
  jwtPayload: 'eyJzdWIiOiJ4MzItc2VudHJ5LWp3dC1tYXJrZXIifQ',
  password: 'x32-PASSWORD-SECRET-pw',
  bodyPassword: 'x32-BODY-PASSWORD-SECRET-bp',
  bodyToken: 'x32-BODY-TOKEN-SECRET-bt',
  queryToken: 'x32-QUERY-TOKEN-SECRET-qt',
  cookie: 'x32-COOKIE-SECRET-ck',
  refreshToken: 'x32-REFRESH-TOKEN-SECRET-rt',
  email: 'carol.x32-marker@example.com',
  ip: '203.0.113.77',
  mfaCode: '918273',
  totpSecret: 'JBSWY3DPX32TOTPSECRET', // gitleaks:allow (synthetic scrubber marker, not a credential)
  manualKey: 'JBSW Y3DP X32M ANUA',
  recoveryCode: 'X32R-ECOV-ERY0',
  otpauthSecret: 'OTPAUTHX32SECRETVALUE',
  challengeToken: 'x32-CHALLENGE-TOKEN-SECRET-ch',
};

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const [name, secret] of Object.entries(SECRETS)) {
    if (text.includes(secret)) throw new Error(`secret "${name}" leaked into the Sentry envelope`);
  }
}

/** A real Sentry client with the production `beforeSend` and an in-memory transport. */
function startCapturingClient(send?: () => Promise<never>): { envelopes: Envelope[]; client: Sentry.NodeClient } {
  const envelopes: Envelope[] = [];
  const production = buildSentryOptions({ SENTRY_DSN: DSN, NODE_ENV: 'production' }, {}, () => undefined)!;
  const client = new Sentry.NodeClient({
    dsn: DSN,
    environment: production.environment,
    sendDefaultPii: production.sendDefaultPii,
    beforeSend: production.beforeSend,
    // LinkedErrors as in production, so an error's `cause` becomes a second exception value that beforeSend must scrub.
    integrations: [Sentry.linkedErrorsIntegration()],
    stackParser: Sentry.defaultStackParser,
    sendClientReports: false,
    transport: () => ({
      send: send ?? (async (envelope: unknown) => (envelopes.push(envelope as Envelope), {})),
      flush: async () => true,
    }),
  });
  Sentry.setCurrentClient(client);
  client.init();
  return { envelopes, client };
}

/** What other code (another integration, a breadcrumb, a stray setExtra) may have put on the scope before the error. */
function pollutedScope(client: Sentry.NodeClient): void {
  Sentry.getIsolationScope().setUser({ id: 'user-1', email: SECRETS.email, ip_address: SECRETS.ip, username: SECRETS.email });
  Sentry.getIsolationScope().setExtra('mfa', {
    mfaCode: SECRETS.mfaCode,
    totpSecret: SECRETS.totpSecret,
    manualKey: SECRETS.manualKey,
    recoveryCodes: [SECRETS.recoveryCode],
    otpauthUri: `otpauth://totp/Crewflow:carol%40example.com?secret=${SECRETS.otpauthSecret}&issuer=Crewflow`,
    challengeToken: SECRETS.challengeToken,
  });
  Sentry.getIsolationScope().setExtra('auth', { password: SECRETS.password, refreshToken: SECRETS.refreshToken });
  // An integration attaching the full request (the restricted RequestData never does; this proves beforeSend strips it).
  client.addEventProcessor((event) => ({
    ...event,
    request: {
      method: 'POST',
      url: `https://api.example.test/rest/v1/auth/login?token=${SECRETS.queryToken}`,
      query_string: `token=${SECRETS.queryToken}`,
      headers: { authorization: `Bearer ${JWT}`, cookie: `rab_session=${SECRETS.cookie}`, 'x-forwarded-for': SECRETS.ip },
      cookies: { rab_session: SECRETS.cookie, rab_refresh: SECRETS.refreshToken },
      data: { email: SECRETS.email, password: SECRETS.bodyPassword, token: SECRETS.bodyToken, code: SECRETS.mfaCode },
      env: { REMOTE_ADDR: SECRETS.ip },
    },
  }));
}

function hostFor(request: unknown) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => request }) } as unknown as ArgumentsHost;
  return { host, status, json };
}

const loginRequest = { method: 'POST', url: `/rest/v1/auth/login?token=${SECRETS.queryToken}`, route: { path: '/rest/v1/auth/login' } };

beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));

afterEach(async () => {
  jest.restoreAllMocks();
  await Sentry.getClient()?.close(0);
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().clear();
  Sentry.getGlobalScope().clear();
});

describe('shouldCaptureException (Twenty: global-exception-handler.util.ts)', () => {
  it('reports server faults only', () => {
    expect(shouldCaptureException(new Error('boom'))).toBe(true);
    expect(shouldCaptureException('a string')).toBe(true);
    expect(shouldCaptureException(new InternalServerErrorException())).toBe(true);
    expect(shouldCaptureException(new NotFoundException())).toBe(false);
    expect(shouldCaptureException(new Error('boom'), 404)).toBe(false);
    expect(shouldCaptureException(new Error('boom'), 500)).toBe(true);
  });
});

describe('ExceptionHandlerService', () => {
  it('passes the exceptions and options to the driver and returns its event ids', () => {
    const driver = { captureExceptions: jest.fn(() => ['id-1']) };
    const service = new ExceptionHandlerService(driver);
    const error = new Error('boom');
    expect(service.captureExceptions([error], { operation: { type: 'worker-cycle', name: 'email dispatch' } })).toEqual(['id-1']);
    expect(driver.captureExceptions).toHaveBeenCalledWith([error], { operation: { type: 'worker-cycle', name: 'email dispatch' } });
  });

  it('a throwing driver never propagates: [] and a fixed warning that never quotes the error', () => {
    const service = new ExceptionHandlerService({
      captureExceptions: () => {
        throw new Error(`driver failed for ${SECRETS.email}`);
      },
    });
    const logSpy = jest.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    expect(service.captureExceptions([new Error('boom')])).toEqual([]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(SECRETS.email);
  });
});

describe('createExceptionHandlerDriver: Sentry off is a no-op', () => {
  it('no SENTRY_DSN → the no-op driver, even with a Sentry client in the process', () => {
    expect(createExceptionHandlerDriver({}, () => true)).toBeInstanceOf(ExceptionHandlerNoopDriver);
    expect(createExceptionHandlerDriver({ SENTRY_DSN: '' }, () => true)).toBeInstanceOf(ExceptionHandlerNoopDriver);
  });

  it('SENTRY_DSN set but no Sentry client (instrument.ts never initialised it) → the no-op driver', () => {
    expect(createExceptionHandlerDriver({ SENTRY_DSN: DSN }, () => false)).toBeInstanceOf(ExceptionHandlerNoopDriver);
  });

  it('SENTRY_DSN set and a client → the Sentry driver', () => {
    expect(createExceptionHandlerDriver({ SENTRY_DSN: DSN }, () => true)).toBeInstanceOf(ExceptionHandlerSentryDriver);
  });

  it('the no-op driver sends nothing: a 500 through the filter reaches no transport and the response is unchanged', async () => {
    const { envelopes, client } = startCapturingClient();
    const service = new ExceptionHandlerService(createExceptionHandlerDriver({}, () => true));
    const { host, status, json } = hostFor(loginRequest);
    new AllExceptionsFilter(service).catch(new Error('boom'), host);
    await client.flush(2000);
    expect(envelopes).toHaveLength(0);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  });

  it('the process default (no SENTRY_DSN in this process) is a no-op', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./exception-handler.service') as typeof import('./exception-handler.service');
      expect(mod.defaultExceptionHandlerService().captureExceptions([new Error('boom')])).toEqual([]);
      expect(mod.defaultExceptionHandlerService()).toBe(mod.defaultExceptionHandlerService());
    });
  });
});

describe('Sentry egress: a 500 is reported as a scrubbed event (instrument.ts beforeSend)', () => {
  it('a 500 through AllExceptionsFilter sends exactly one event, with no header, cookie, body, token, password, email or MFA value', async () => {
    const { envelopes, client } = startCapturingClient();
    pollutedScope(client);
    const service = new ExceptionHandlerService(new ExceptionHandlerSentryDriver());
    const { host, status, json } = hostFor(loginRequest);
    const error = new Error(
      `login failed for ${SECRETS.email} password=${SECRETS.password} Authorization: Bearer ${JWT} refresh_token=${SECRETS.refreshToken}`,
    );

    new AllExceptionsFilter(service).catch(error, host);
    await client.flush(2000);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
    const events = envelopes.flatMap(([, items]) => items).filter(([header]) => header.type === 'event').map(([, payload]) => payload as Sentry.Event);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expectNoSecrets(envelopes);
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.env).toBeUndefined();
    expect(event.request?.url).toBe('https://api.example.test/rest/v1/auth/login');
    expect(event.user).toEqual({ id: 'user-1' });
    // Still useful: the error class, the stack and the operation (method + route pattern).
    expect(event.exception?.values?.[0]?.type).toBe('Error');
    expect(event.exception?.values?.[0]?.value).toContain('login failed for');
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
    expect(event.extra?.operation).toBe('POST /rest/v1/auth/login');
    expect(event.extra?.operationType).toBe('http');
  });

  it('a 4xx sends nothing', async () => {
    const { envelopes, client } = startCapturingClient();
    const service = new ExceptionHandlerService(new ExceptionHandlerSentryDriver());
    const { host, status } = hostFor(loginRequest);
    new AllExceptionsFilter(service).catch(new NotFoundException('Shift not found.'), host);
    await client.flush(2000);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(envelopes).toHaveLength(0);
  });

  it('a transport that rejects (Sentry unreachable) never changes the response and never throws', async () => {
    const { client } = startCapturingClient(async () => {
      throw new Error('ECONNREFUSED sentry.example.test');
    });
    const service = new ExceptionHandlerService(new ExceptionHandlerSentryDriver());
    const { host, status, json } = hostFor(loginRequest);
    expect(() => new AllExceptionsFilter(service).catch(new Error('boom'), host)).not.toThrow();
    await expect(client.flush(2000)).resolves.toBeDefined();
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  });

  it('a Sentry SDK that throws inside the driver never changes the response', () => {
    const broken: SentryCaptureApi = {
      withScope: (callback) => callback(new Sentry.Scope()),
      captureException: () => {
        throw new Error('sdk exploded');
      },
    };
    const service = new ExceptionHandlerService(new ExceptionHandlerSentryDriver(broken));
    jest.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    const { host, status, json } = hostFor(loginRequest);
    new AllExceptionsFilter(service).catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  });

  it('the Sentry driver adds only the two operation extras to the scope (nothing copied off the exception)', async () => {
    const { envelopes, client } = startCapturingClient();
    const error = Object.assign(new Error('boom'), { context: { password: SECRETS.password }, cause: new Error(`cause ${SECRETS.email}`) });
    new ExceptionHandlerSentryDriver().captureExceptions([error], { operation: { type: 'worker-cycle', name: 'email dispatch' } });
    await client.flush(2000);
    const event = envelopes.flatMap(([, items]) => items).map(([, payload]) => payload as Sentry.Event)[0]!;
    expect(event.extra).toEqual({ operation: 'email dispatch', operationType: 'worker-cycle' });
    expect(event.exception?.values).toHaveLength(2); // the cause, scrubbed, as LinkedErrors adds it
    expectNoSecrets(envelopes);
  });
});
