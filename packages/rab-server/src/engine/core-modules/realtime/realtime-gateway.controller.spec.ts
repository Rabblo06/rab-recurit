import { HttpException, HttpStatus, MessageEvent } from '@nestjs/common';

import { RealtimeConnectionRegistryService } from './realtime-connection-registry.service';
import { REALTIME_CAP_RETRY_AFTER_SECONDS, RealtimeGatewayController, realtimeKeepaliveMs } from './realtime-gateway.controller';

const VECTOR = { sessionVersion: 1, userVersion: 1, rolePermissionVersion: 1, workspaceMembershipVersion: 1, platformAdminVersion: 1, organisationVersion: 1 };

function controllerWith(env: Record<string, unknown>, registry: Partial<RealtimeConnectionRegistryService> = new RealtimeConnectionRegistryService()) {
  const tenantContext = { runInTenantContext: jest.fn(async (_ctx: unknown, fn: (m: unknown) => unknown) => fn({})) };
  const securityVersion = { readVector: jest.fn(async () => VECTOR) };
  const sessionValidity = { assertActiveReadOnly: jest.fn(async () => undefined) };
  const subscriber = { subscribe: jest.fn(async () => undefined), unsubscribe: jest.fn(async () => undefined) };
  const controller = new RealtimeGatewayController(
    { get: (key: string) => env[key] } as any,
    tenantContext as any,
    securityVersion as any,
    sessionValidity as any,
    {} as any,
    registry as any,
    { subscriber } as any,
  );
  return { controller, registry, subscriber };
}

function requestFor(userId = 'u-1') {
  const headers: Record<string, string> = {};
  return {
    authContext: { userId, organisationId: 'o-1', workspaceId: null, sessionId: 's-1', role: '' },
    cookies: {},
    headers: {},
    res: { setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value) },
    sentHeaders: headers,
  } as any;
}

const ENABLED = { REALTIME_ENABLED: true, REALTIME_MAX_CONNECTIONS_PER_USER: 2, NODE_ENV: 'test', REALTIME_HEARTBEAT_INTERVAL_MS: 30_000 };

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('RealtimeGatewayController.stream', () => {
  afterEach(() => jest.useRealTimers());

  it('answers 204 when real-time is disabled — never a 200 stream that ends immediately (reconnect-loop regression)', () => {
    const registry = { countForUser: jest.fn(() => 0), register: jest.fn(), unregister: jest.fn() };
    const { controller } = controllerWith({ REALTIME_ENABLED: false }, registry as any);
    let thrown: unknown;
    try {
      controller.stream(requestFor());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.NO_CONTENT);
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('still opens a stream when real-time is enabled', () => {
    const { controller } = controllerWith(ENABLED);
    expect(() => controller.stream(requestFor())).not.toThrow();
  });

  describe('C1b — per-user cap is a 429 + Retry-After BEFORE the stream opens', () => {
    it('refuses the (cap+1)th connection synchronously with 429 and Retry-After — not a 200 stream that completes at once', () => {
      const { controller, registry } = controllerWith(ENABLED);
      const subs = [controller.stream(requestFor()).subscribe(), controller.stream(requestFor()).subscribe()];
      expect((registry as RealtimeConnectionRegistryService).countForUser('u-1')).toBe(2);

      const req = requestFor();
      let thrown: unknown;
      try {
        controller.stream(req);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((thrown as HttpException).getResponse()).toMatchObject({ code: 'REALTIME_CONNECTION_LIMIT' });
      expect(req.sentHeaders['retry-after']).toBe(String(REALTIME_CAP_RETRY_AFTER_SECONDS));
      subs.forEach((s) => s.unsubscribe());
    });

    it('the slot is reserved at subscribe time, so two handlers that passed the check in the same tick cannot both stream (the second errors 429)', () => {
      const { controller, registry } = controllerWith({ ...ENABLED, REALTIME_MAX_CONNECTIONS_PER_USER: 1 });
      const a = controller.stream(requestFor());
      const b = controller.stream(requestFor()); // both handlers ran before either stream was subscribed
      const subA = a.subscribe();
      let bError: unknown;
      const subB = b.subscribe({ error: (e) => (bError = e) });
      expect((bError as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((registry as RealtimeConnectionRegistryService).countForUser('u-1')).toBe(1);
      subA.unsubscribe();
      subB.unsubscribe();
      expect((registry as RealtimeConnectionRegistryService).countForUser('u-1')).toBe(0);
    });

    it('a closed connection frees its slot for the next one', () => {
      const { controller } = controllerWith({ ...ENABLED, REALTIME_MAX_CONNECTIONS_PER_USER: 1 });
      controller.stream(requestFor()).subscribe().unsubscribe();
      expect(() => controller.stream(requestFor()).subscribe().unsubscribe()).not.toThrow();
    });

    it('the cap is per user: another user is unaffected', () => {
      const { controller } = controllerWith({ ...ENABLED, REALTIME_MAX_CONNECTIONS_PER_USER: 1 });
      const sub = controller.stream(requestFor('u-1')).subscribe();
      expect(() => controller.stream(requestFor('u-2'))).not.toThrow();
      sub.unsubscribe();
    });
  });

  describe('C1b — keepalive bytes', () => {
    it('keepalive interval is min(heartbeat, 25 s)', () => {
      expect(realtimeKeepaliveMs(30_000)).toBe(25_000);
      expect(realtimeKeepaliveMs(5_000)).toBe(5_000);
    });

    it('writes a `connected` comment once subscribed, then a `keepalive` comment every interval — comments only, never events', async () => {
      jest.useFakeTimers();
      const { controller } = controllerWith(ENABLED);
      const seen: MessageEvent[] = [];
      const sub = controller.stream(requestFor()).subscribe((m) => seen.push(m));
      await flush();
      expect(seen).toEqual([{ comment: 'connected' }]);

      jest.advanceTimersByTime(25_000);
      await flush();
      expect(seen.filter((m) => m.comment === 'keepalive')).toHaveLength(1);
      jest.advanceTimersByTime(25_000);
      await flush();
      expect(seen.filter((m) => m.comment === 'keepalive')).toHaveLength(2);
      expect(seen.every((m) => m.data === undefined && m.type === undefined)).toBe(true);

      sub.unsubscribe();
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(seen.filter((m) => m.comment === 'keepalive')).toHaveLength(2); // timer cleared on teardown
    });
  });
});
