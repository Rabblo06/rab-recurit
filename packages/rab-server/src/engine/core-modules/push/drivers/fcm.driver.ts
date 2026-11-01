import { createHash } from 'node:crypto';

import type { Messaging } from 'firebase-admin/messaging';

import { PushDriverInterface, PushSendError, PushSendOptions, PushSendResult } from './interfaces/push-driver.interface';

/**
 * D5 (D0-C §4.1): ONE Firebase app per process and credential. firebase-admin refuses a second app with the same name, and
 * PushDriverFactory used to build a new driver per send that called initializeApp() on the DEFAULT app each time — so
 * only the first Android push per Worker process could succeed. The Messaging client is now cached at module level, keyed
 * by a hash of the credential (never the credential itself), on a NAMED app (`crewflow-fcm-<hash16>`, so no other library's
 * default app is touched). The cache holds the in-flight initialisation PROMISE, so concurrent first sends share one
 * initializeApp(); a failed initialisation is evicted so a later send can retry. An app that already exists under that
 * name (another module instance) is reused, never re-created.
 */
const FCM_APP_NAME_PREFIX = 'crewflow-fcm-';
const messagingByCredential = new Map<string, Promise<Messaging>>();

/** Test-only: forget the cached clients (the Firebase apps themselves are left as they are). */
export function resetFcmAppsForTests(): void {
  messagingByCredential.clear();
}

function credentialKey(serviceAccountJson: string | undefined): string {
  return serviceAccountJson ? createHash('sha256').update(serviceAccountJson).digest('hex').slice(0, 16) : 'application-default'.padEnd(16, '0').slice(0, 16);
}

async function initialiseMessaging(serviceAccountJson: string | undefined, appName: string): Promise<Messaging> {
  // Lazy import — `firebase-admin` is a real dependency of this package, but nothing outside this file touches it, and
  // this only ever runs when PUSH_PROVIDER=REAL was explicitly chosen for an android device; the fake driver and every
  // ordinary test path never load it.
  const { initializeApp, applicationDefault, cert, getApps } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');

  const existing = getApps().find((app) => app?.name === appName);
  if (existing) return getMessaging(existing);

  if (serviceAccountJson) {
    let parsed: import('firebase-admin/app').ServiceAccount;
    try {
      parsed = JSON.parse(serviceAccountJson) as import('firebase-admin/app').ServiceAccount;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
    return getMessaging(initializeApp({ credential: cert(parsed) }, appName));
  }
  // Workload identity / application default credentials — the owner's preferred path once a hosting environment supports
  // it. Throws loudly if no ambient credential is available — never silently falls back to an unauthenticated client.
  return getMessaging(initializeApp({ credential: applicationDefault() }, appName));
}

function sharedMessaging(serviceAccountJson: string | undefined): Promise<Messaging> {
  const key = credentialKey(serviceAccountJson);
  let pending = messagingByCredential.get(key);
  if (!pending) {
    const created = initialiseMessaging(serviceAccountJson, `${FCM_APP_NAME_PREFIX}${key}`);
    pending = created;
    messagingByCredential.set(key, created);
    created.catch(() => {
      if (messagingByCredential.get(key) === created) messagingByCredential.delete(key);
    });
  }
  return pending;
}

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
 *
 * Timeouts: firebase-admin's own per-request timeout (15 s) and its internal retries apply (D0-C §4.10, unchanged).
 */
export class FcmDriver implements PushDriverInterface {
  readonly name = 'fcm';
  readonly ambiguousDeliverySafeToRetry = false;

  constructor(private readonly serviceAccountJson: string | undefined) {}

  private ensureInitialized(): Promise<Messaging> {
    return sharedMessaging(this.serviceAccountJson);
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
