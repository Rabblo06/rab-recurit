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

const PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1000; // Apple allows up to 60 minutes; refresh at 45 to stay well inside it.

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

  constructor(private readonly config: ApnsDriverConfig) {}

  private get host(): string {
    return this.config.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  }

  private signProviderToken(): string {
    const now = Date.now();
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

  async send(options: PushSendOptions): Promise<PushSendResult> {
    if (!this.config.bundleId) {
      throw new Error('APNS_BUNDLE_ID is required for PUSH_PROVIDER=REAL ios delivery.');
    }
    const jwt = this.signProviderToken();
    const payload = JSON.stringify({
      aps: { alert: { title: options.title, body: options.body }, 'mutable-content': 1 },
      ...(options.data ?? {}),
    });

    const client = http2.connect(`https://${this.host}`);
    try {
      const { status, headers, body } = await new Promise<{ status: number; headers: http2.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = client.request({
            ':method': 'POST',
            ':path': `/3/device/${options.token}`,
            authorization: `bearer ${jwt}`,
            'apns-topic': this.config.bundleId,
            'apns-push-type': 'alert',
            'content-type': 'application/json',
          });
          let responseHeaders: http2.IncomingHttpHeaders = {};
          let data = '';
          req.on('response', (h) => {
            responseHeaders = h;
          });
          req.setEncoding('utf8');
          req.on('data', (chunk: string) => {
            data += chunk;
          });
          req.on('end', () => resolve({ status: Number(responseHeaders[':status']), headers: responseHeaders, body: data }));
          req.on('error', reject);
          req.write(payload);
          req.end();
        },
      );

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
    } finally {
      client.close();
    }
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
