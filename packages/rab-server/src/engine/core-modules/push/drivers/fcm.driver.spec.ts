/**
 * D5 / D0-C §4.1: one Firebase app per process. Before this, PushDriverFactory built a new FcmDriver per send and each
 * called initializeApp({credential}) on the DEFAULT app — firebase-admin refuses a second app with the same name, so only
 * the first Android push per Worker process could succeed. firebase-admin is mocked here with the same duplicate-name
 * rule; no network, no credential.
 */
const apps = new Map<string, { name: string }>();
const initializeApp = jest.fn((_options: unknown, name = '[DEFAULT]') => {
  if (apps.has(name)) {
    throw Object.assign(new Error(`The default Firebase app already exists (name "${name}")`), { code: 'app/duplicate-app' });
  }
  const app = { name };
  apps.set(name, app);
  return app;
});
const send = jest.fn(async () => 'projects/p/messages/1');
const getMessaging = jest.fn((app: { name: string }) => ({ app, send }));

jest.mock('firebase-admin/app', () => ({
  initializeApp: (options: unknown, name?: string) => initializeApp(options, name),
  getApps: () => [...apps.values()],
  getApp: (name = '[DEFAULT]') => {
    const app = apps.get(name);
    if (!app) throw Object.assign(new Error('no app'), { code: 'app/no-app' });
    return app;
  },
  cert: (sa: unknown) => ({ kind: 'cert', sa }),
  applicationDefault: () => ({ kind: 'adc' }),
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: (app: { name: string }) => getMessaging(app) }));

import { FcmDriver, resetFcmAppsForTests } from './fcm.driver';

const SA = JSON.stringify({ project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com', private_key: 'not-a-real-key' });
const msg = { token: 't', title: 'T', body: 'B', data: { notificationId: 'n1', type: 'x' } };

describe('FcmDriver — one Firebase app per process', () => {
  beforeEach(() => {
    apps.clear();
    initializeApp.mockClear();
    getMessaging.mockClear();
    send.mockClear();
    resetFcmAppsForTests();
  });

  it('a new driver per send (what the factory used to do) still initialises Firebase once, and every send succeeds', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(new FcmDriver(SA).send(msg)).resolves.toEqual({ provider: 'fcm', providerMessageId: 'projects/p/messages/1' });
    }
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('concurrent first sends share one in-flight initialisation (no duplicate-app race)', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => new FcmDriver(SA).send(msg)));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('uses a NAMED app (never the default app another library might own) and reuses one that already exists', async () => {
    await new FcmDriver(SA).send(msg);
    const name = initializeApp.mock.calls[0]![1] as string;
    expect(name).toMatch(/^crewflow-fcm-[0-9a-f]{16}$/);
    expect(name).not.toContain('not-a-real-key');
    // A second module instance (or a reset cache) finds the app by name instead of creating it again.
    resetFcmAppsForTests();
    await expect(new FcmDriver(SA).send(msg)).resolves.toBeDefined();
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('application default credentials get their own app; a different credential gets a different app', async () => {
    await new FcmDriver(undefined).send(msg);
    await new FcmDriver(SA).send(msg);
    expect(initializeApp).toHaveBeenCalledTimes(2);
    expect(new Set(initializeApp.mock.calls.map((c) => c[1])).size).toBe(2);
  });

  it('a failed initialisation is not cached: the error is clear and the next send can initialise', async () => {
    await expect(new FcmDriver('{not json').send(msg)).rejects.toThrow(/FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON/);
    initializeApp.mockImplementationOnce(() => {
      throw new Error('transient init failure');
    });
    await expect(new FcmDriver(SA).send(msg)).rejects.toThrow(/transient init failure/);
    await expect(new FcmDriver(SA).send(msg)).resolves.toBeDefined();
  });

  it('provider errors are still classified (invalid token / permanent / retryable)', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' }));
    await expect(new FcmDriver(SA).send(msg)).rejects.toMatchObject({ retryable: false, invalidToken: true });
    send.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'messaging/server-unavailable' }));
    await expect(new FcmDriver(SA).send(msg)).rejects.toMatchObject({ retryable: true, invalidToken: false });
  });
});
