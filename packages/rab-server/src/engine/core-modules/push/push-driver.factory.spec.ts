import { EnvironmentService } from '../environment/environment.service';
import { ApnsDriver } from './drivers/apns.driver';
import { FakeFcmDriver } from './drivers/fake-fcm.driver';
import { FcmDriver } from './drivers/fcm.driver';
import { PushDriverFactory } from './push-driver.factory';

/**
 * D5: the REAL drivers are built once per factory (one per process — the factory is a Nest singleton), so APNs reuses
 * its HTTP/2 session and cached provider JWT across sends instead of reconnecting and re-signing per push. No network:
 * nothing here sends.
 */
function factory(values: Record<string, string | undefined>): PushDriverFactory {
  const env = { get: (key: string) => values[key] } as unknown as EnvironmentService;
  return new PushDriverFactory(env);
}

const REAL = {
  PUSH_PROVIDER: 'REAL',
  FIREBASE_SERVICE_ACCOUNT_JSON: undefined,
  APNS_AUTH_KEY_P8: 'k',
  APNS_KEY_ID: 'K',
  APNS_TEAM_ID: 'T',
  APNS_BUNDLE_ID: 'com.rab.rab_staff',
  APNS_ENVIRONMENT: 'sandbox',
};

describe('PushDriverFactory — one real driver per process', () => {
  it('returns the same APNs and FCM driver on every call', () => {
    const f = factory(REAL);
    const ios = f.getDriver('ios');
    expect(ios).toBeInstanceOf(ApnsDriver);
    expect(f.getDriver('ios')).toBe(ios);
    const android = f.getDriver('android');
    expect(android).toBeInstanceOf(FcmDriver);
    expect(f.getDriver('android')).toBe(android);
  });

  it('closes the APNs session on application shutdown', () => {
    const f = factory(REAL);
    const ios = f.getDriver('ios') as ApnsDriver;
    const close = jest.spyOn(ios, 'close');
    f.onApplicationShutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('FAKE mode is unchanged (a fresh stateless fake; its state is static) and an unknown provider still throws', () => {
    expect(factory({ PUSH_PROVIDER: 'FAKE' }).getDriver('ios')).toBeInstanceOf(FakeFcmDriver);
    expect(() => factory({ PUSH_PROVIDER: 'OTHER' }).getDriver('ios')).toThrow(/Invalid PUSH_PROVIDER/);
  });
});
