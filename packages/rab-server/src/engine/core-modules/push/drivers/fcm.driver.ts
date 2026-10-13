import type { App } from 'firebase-admin/app';
import type { Messaging } from 'firebase-admin/messaging';

import { PushDriverInterface, PushSendError, PushSendOptions, PushSendResult } from './interfaces/push-driver.interface';

/**
 * The real FCM driver — official `firebase-admin` SDK (HTTP v1 under the hood), never a hand-
 * rolled HTTP call. NOT instantiated by default: `PushDriverFactory` only builds one of these
 * for an android device when `PUSH_PROVIDER=REAL` is explicitly set — so no code path can
 * accidentally reach a real provider call without an explicit, already-approved configuration
 * choice (Stage 6 §6/§16: never created automatically, never a committed credential).
 *
 * Credential: `FIREBASE_SERVICE_ACCOUNT_JSON` (the service-account JSON, as a string — never
 * committed to `.env`/`.env.example`, never logged). Prefers workload identity / application
 * default credentials where the eventual hosting environment supports it
 * (`admin.credential.applicationDefault()`), falling back to the explicit service-account JSON
 * only when provided — matching the owner's own stated preference order.
 */
export class FcmDriver implements PushDriverInterface {
  readonly name = 'fcm';
  readonly ambiguousDeliverySafeToRetry = false;

  private app: App | null = null;
  private messaging: Messaging | null = null;

  constructor(private readonly serviceAccountJson: string | undefined) {}

  private async ensureInitialized(): Promise<Messaging> {
    if (this.messaging) return this.messaging;

    // Lazy import — `firebase-admin` is a real dependency of this package, but nothing outside
    // this file touches it, and this method only ever runs when PUSH_PROVIDER=REAL was explicitly
    // chosen for an android device; the fake driver and every ordinary test path never load it.
    const { initializeApp, applicationDefault, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');

    if (this.serviceAccountJson) {
      let parsed: import('firebase-admin/app').ServiceAccount;
      try {
        parsed = JSON.parse(this.serviceAccountJson) as import('firebase-admin/app').ServiceAccount;
      } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
      }
      this.app = initializeApp({ credential: cert(parsed) });
    } else {
      // Workload identity / application default credentials — the owner's preferred path once a
      // hosting environment supports it. Throws here, synchronously and loudly, if no ambient
      // credential is actually available — never silently falls back to an unauthenticated client.
      this.app = initializeApp({ credential: applicationDefault() });
    }
    this.messaging = getMessaging(this.app);
    return this.messaging;
  }

  async send(options: PushSendOptions): Promise<PushSendResult> {
    const messaging = await this.ensureInitialized();
    try {
      const providerMessageId = await messaging.send({
        token: options.token,
        notification: { title: options.title, body: options.body },
        data: options.data,
      });
      return { provider: this.name, providerMessageId };
    } catch (error: unknown) {
      throw this.classify(error);
    }
  }

  /**
   * FCM error-code classification — mirrors `email-send.processor.ts`'s own `isRetryable()`
   * precedent: unrecognised errors default to retryable (fail-safe toward retry, never toward
   * silently dropping a real delivery). `messaging/registration-token-not-registered` and
   * `messaging/invalid-registration-token` are the two documented permanent, invalid-token codes
   * (Stage 6 §6: "invalid-device cleanup") — everything else permanent-but-not-invalid-token
   * (`messaging/invalid-argument`, `messaging/sender-id-mismatch`, `messaging/third-party-auth-error`)
   * stops retrying this delivery without deactivating the device, since the token itself may
   * still be good.
   */
  private classify(error: unknown): PushSendError {
    const code = (error as { code?: string; errorInfo?: { code?: string } })?.code ?? (error as { errorInfo?: { code?: string } })?.errorInfo?.code;
    const message = error instanceof Error ? error.message : 'unknown FCM error';

    const invalidTokenCodes = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
    const permanentCodes = new Set([
      'messaging/invalid-argument',
      'messaging/sender-id-mismatch',
      'messaging/third-party-auth-error',
      'messaging/mismatched-credential',
    ]);

    if (code && invalidTokenCodes.has(code)) return new PushSendError(message, false, true, code);
    if (code && permanentCodes.has(code)) return new PushSendError(message, false, false, code);
    // messaging/internal-error, messaging/server-unavailable, messaging/quota-exceeded,
    // unknown/unclassified — retryable by default, same fail-safe direction as the email driver.
    return new PushSendError(message, true, false, code);
  }
}
