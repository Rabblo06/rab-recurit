import { PushDriverInterface, PushSendError, PushSendOptions, PushSendResult } from './interfaces/push-driver.interface';

/**
 * Deterministic, in-memory FCM stand-in — the default driver (`PUSH_PROVIDER` unset or `FAKE`)
 * so ordinary backend tests and local dev never require real Firebase/APNs credentials (Stage 6
 * §6/§14: "Do not require Firebase or Apple credentials to run ordinary backend unit tests").
 *
 * Deliberately configurable per-test via `FakeFcmDriver.behaviorForToken` (a static map, cleared
 * between test files) rather than one single hardcoded always-succeeds response — otherwise no
 * test could exercise retry/failure/invalid-token classification without a real provider at all.
 * A token not present in the map succeeds, matching "the common case is success" without every
 * test needing to register one.
 */
export type FakeFcmBehavior =
  | { outcome: 'accept'; providerMessageId?: string }
  | { outcome: 'retryable-error'; code?: string }
  | { outcome: 'permanent-error'; code?: string }
  | { outcome: 'invalid-token'; code?: string };

export class FakeFcmDriver implements PushDriverInterface {
  readonly name = 'fake-fcm';
  readonly ambiguousDeliverySafeToRetry = false;

  /** Keyed by raw token. Reset with `FakeFcmDriver.reset()` in `afterEach`/`beforeEach`. */
  static behaviorForToken = new Map<string, FakeFcmBehavior>();
  static sentMessages: Array<{ token: string; title: string; body: string; data?: Record<string, string> }> = [];

  static reset(): void {
    FakeFcmDriver.behaviorForToken.clear();
    FakeFcmDriver.sentMessages = [];
  }

  async send(options: PushSendOptions): Promise<PushSendResult> {
    FakeFcmDriver.sentMessages.push({ token: options.token, title: options.title, body: options.body, data: options.data });
    const behavior = FakeFcmDriver.behaviorForToken.get(options.token) ?? { outcome: 'accept' as const };

    switch (behavior.outcome) {
      case 'accept':
        return { provider: this.name, providerMessageId: behavior.providerMessageId ?? `fake-${Date.now()}-${Math.random().toString(36).slice(2)}` };
      case 'retryable-error':
        throw new PushSendError('fake retryable provider error', true, false, behavior.code ?? 'UNAVAILABLE');
      case 'permanent-error':
        throw new PushSendError('fake permanent provider error', false, false, behavior.code ?? 'INTERNAL');
      case 'invalid-token':
        throw new PushSendError('fake invalid/unregistered token', false, true, behavior.code ?? 'UNREGISTERED');
    }
  }
}
