import { sign } from 'node:crypto';
import * as http2 from 'node:http2';

import { PushDriverInterface, PushSendError, PushSendOptions, PushSendResult } from './interfaces/push-driver.interface';

export interface ApnsDriverConfig {
  authKeyP8: string | undefined;
  keyId: string | undefined;
  teamId: string | undefined;
  bundleId: string | undefined;
  environment: 'sandbox' | 'production';
}

/**
 * Provider JWT lifetime in the cache. Apple accepts a token for up to 60 minutes and answers 429
 * TooManyProviderTokenUpdates when it changes more than once per 20 minutes; 45 minutes is inside both (D5: ≤ 50 min,
 * re-signed before expiry, never per push).
 */
export const APNS_PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1000;
const PROVIDER_TOKEN_TTL_MS = APNS_PROVIDER_TOKEN_TTL_MS;

/**
 * D5 transport bounds. Request 10 s (connect wait included) and connect 5 s keep a send far inside the push PROCESSING
 * lease (10 min today; the D4 test target is 30 s). Idle sessions close after 5 min.
 */
export const APNS_REQUEST_TIMEOUT_MS = 10_000;
export const APNS_CONNECT_TIMEOUT_MS = 5_000;
export const APNS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Test seams (a local HTTP/2 server, short timers, a clock). Production uses the defaults and Apple's host. */
export interface ApnsTransportOptions {
  origin?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
}

/**
 * The real direct-APNs driver — Apple's HTTP/2 Provider API, called directly over Node's built-in
 * `http2` client. Deliberately NOT routed through Firebase/FCM: the owner's explicit architecture
 * decision is Android via FCM, iPhone via direct Apple APNs, so this talks to
 * `api(.sandbox).push.apple.com` on its own, signing its own provider JWT (ES256) from the `.p8`
 * auth key rather than depending on any Firebase credential or SDK.
 *
 * NOT instantiated by default: `PushDriverFactory` only builds one of these for an ios device when
 * `PUSH_PROVIDER=REAL` is explicitly set (Stage 6 §16: never created automatically, never a
 * committed credential). Implemented and unit-testable via its JWT-signing and response-classifying
 * logic, but — same honesty requirement as the rest of Stage 6 — NEVER VERIFIED AGAINST REAL APPLE
 * SERVERS, because no APNs auth key, Team ID, Key ID or bundle ID exists in this environment. This
 * is "implemented," not "device-delivery verified."
 */
export class ApnsDriver implements PushDriverInterface {
  readonly name = 'apns';
  readonly ambiguousDeliverySafeToRetry = false;

  private cachedProviderToken: { jwt: string; issuedAt: number } | null = null;
  private session: http2.ClientHttp2Session | null = null;
  private readonly origin: string;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly config: ApnsDriverConfig,
    transport: ApnsTransportOptions = {},
  ) {
    this.origin = transport.origin ?? `https://${this.host}`;
    this.requestTimeoutMs = transport.requestTimeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = transport.connectTimeoutMs ?? APNS_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = transport.idleTimeoutMs ?? APNS_IDLE_TIMEOUT_MS;
    this.now = transport.now ?? Date.now;
  }

  private get host(): string {
    return this.config.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  }

  private signProviderToken(): string {
    const now = this.now();
    if (this.cachedProviderToken && now - this.cachedProviderToken.issuedAt < PROVIDER_TOKEN_TTL_MS) {
      return this.cachedProviderToken.jwt;
    }
    if (!this.config.authKeyP8 || !this.config.keyId || !this.config.teamId) {
      throw new Error('APNS_AUTH_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID are all required for PUSH_PROVIDER=REAL ios delivery.');
    }
    const header = { alg: 'ES256', kid: this.config.keyId };
    const payload = { iss: this.config.teamId, iat: Math.floor(now / 1000) };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signingInput = `${encode(header)}.${encode(payload)}`;
    // ES256 JWT signatures are raw r||s (IEEE P1363), never Node's default DER encoding.
    const signature = sign('sha256', Buffer.from(signingInput), { key: this.config.authKeyP8, dsaEncoding: 'ieee-p1363' });
    const jwt = `${signingInput}.${signature.toString('base64url')}`;
    this.cachedProviderToken = { jwt, issuedAt: now };
    return jwt;
  }

  /**
   * The driver's one active HTTP/2 session (bounded: one per driver; the factory keeps one driver per process). A session
   * that received GOAWAY, closed, errored or idled out is dropped here and a new one is opened on the next send; a dropped
   * session that still carries streams is closed gracefully (close() lets them finish) and then goes away on its own.
   */
  private getSession(): http2.ClientHttp2Session {
    const current = this.session;
    if (current && !current.closed && !current.destroyed) return current;
    this.session = null;

    const session = http2.connect(this.origin);
    this.session = session;
    const drop = () => {
      if (this.session === session) this.session = null;
    };
    const connectTimer = setTimeout(() => {
      // Never connected: destroy it so queued requests fail now (their own timers would fire anyway).
      if (!session.connecting) return;
      drop();
      session.destroy(new Error('APNs connection timed out'));
    }, this.connectTimeoutMs);
    connectTimer.unref?.();
    session.once('connect', () => clearTimeout(connectTimer));
    // A session-level error with no listener would be an uncaught 'error' event (process crash). Requests on the session
    // see their own stream errors; here the session is only dropped so the next send reconnects.
    session.on('error', () => {
      clearTimeout(connectTimer);
      drop();
    });
    session.on('goaway', () => {
      drop();
      if (!session.closed && !session.destroyed) session.close();
    });
    session.on('close', () => {
      clearTimeout(connectTimer);
      drop();
    });
    // Idle handling: no activity for idleTimeoutMs → close gracefully (Apple keeps idle connections only so long; a stale
    // NAT/LB path is worse than a reconnect).
    session.setTimeout(this.idleTimeoutMs, () => {
      drop();
      if (!session.closed && !session.destroyed) session.close();
    });
    // Never keep a Worker process alive just for an idle push connection.
    session.unref();
    return session;
  }

  /** Closes the current session (process shutdown / tests). Safe to call more than once. */
  close(): void {
    const session = this.session;
    this.session = null;
    if (session && !session.closed && !session.destroyed) session.close();
  }

  async send(options: PushSendOptions): Promise<PushSendResult> {
    if (!this.config.bundleId) {
      throw new Error('APNS_BUNDLE_ID is required for PUSH_PROVIDER=REAL ios delivery.');
    }
    const jwt = this.signProviderToken();
    const payload = JSON.stringify({
      aps: { alert: { title: options.title, body: options.body }, 'mutable-content': 1 },
      ...(options.data ?? {}),
    });

    const session = this.getSession();
    const { status, headers, body } = await new Promise<{ status: number; headers: http2.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      let settled = false;
      const fail = (error: PushSendError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      let req: http2.ClientHttp2Stream;
      try {
        req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${options.token}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': this.config.bundleId,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
        });
      } catch (error) {
        // The session died between getSession() and request() (e.g. GOAWAY just arrived): retryable, never a crash.
        if (this.session === session) this.session = null;
        fail(new PushSendError(`APNs session unavailable: ${(error as Error).message}`, true, false, 'session'));
        return;
      }
      let responseHeaders: http2.IncomingHttpHeaders = {};
      let data = '';
      // Bounded request time (connect wait included: the request is queued until the session connects). A timed-out
      // request is retryable — at-least-once delivery, as documented for every provider (PHASE-D-PLAN §7.6).
      req.setTimeout(this.requestTimeoutMs, () => {
        fail(new PushSendError(`APNs request timed out after ${this.requestTimeoutMs} ms`, true, false, 'timeout'));
        req.close(http2.constants.NGHTTP2_CANCEL);
      });
      req.on('response', (h) => {
        responseHeaders = h;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        data += chunk;
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: Number(responseHeaders[':status']), headers: responseHeaders, body: data });
      });
      req.on('error', (error: Error) => fail(new PushSendError(`APNs transport error: ${error.message}`, true, false, (error as { code?: string }).code ?? 'transport')));
      req.on('close', () => fail(new PushSendError('APNs stream closed before a response', true, false, 'closed')));
      req.end(payload);
    });

    if (status === 200) {
      const providerMessageId = typeof headers['apns-id'] === 'string' ? headers['apns-id'] : undefined;
      return { provider: this.name, providerMessageId };
    }
    const reason = (() => {
      try {
        return (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        return undefined;
      }
    })();
    throw this.classify(status, reason);
  }

  /**
   * APNs status/reason classification (Apple's documented `reason` values for the HTTP/2 Provider
   * API). `Unregistered`/`BadDeviceToken` (410, or 400 for a malformed token) are the permanent,
   * invalid-token cases — same "invalid-device cleanup" contract `FcmDriver.classify` implements.
   * `ExpiredProviderToken`/`InvalidProviderToken` (403) invalidate our cached JWT so the next
   * attempt re-signs, and are retryable — a provider-token problem is ours to fix, not the device's.
   * Everything else defaults to retryable, same fail-safe direction as the FCM driver.
   */
  private classify(status: number, reason: string | undefined): PushSendError {
    const message = `APNs error: status=${status} reason=${reason ?? 'unknown'}`;
    const invalidTokenReasons = new Set(['Unregistered', 'BadDeviceToken']);
    if (status === 410 || (status === 400 && reason && invalidTokenReasons.has(reason))) {
      return new PushSendError(message, false, true, reason);
    }
    if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) {
      this.cachedProviderToken = null;
      return new PushSendError(message, true, false, reason);
    }
    if (status === 400) {
      // BadTopic, PayloadTooLarge, MissingTopic, etc. — a code/config bug, never the device's fault.
      return new PushSendError(message, false, false, reason);
    }
    // 429 TooManyRequests, 5xx, and any unrecognised status — retryable by default.
    return new PushSendError(message, true, false, reason);
  }
}
