import { HttpException, HttpStatus } from '@nestjs/common';

import { RealtimeGatewayController } from './realtime-gateway.controller';

function controllerWith(env: Record<string, unknown>) {
  const registry = { countForUser: jest.fn(() => 0), register: jest.fn(), unregister: jest.fn() };
  const controller = new RealtimeGatewayController(
    { get: (key: string) => env[key] } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    registry as any,
    { subscriber: { subscribe: jest.fn(), unsubscribe: jest.fn() } } as any,
  );
  return { controller, registry };
}

const request = { authContext: { userId: 'u-1', organisationId: 'o-1', workspaceId: null, sessionId: 's-1', role: '' }, cookies: {}, headers: {} } as any;

describe('RealtimeGatewayController.stream', () => {
  it('answers 204 when real-time is disabled — never a 200 stream that ends immediately (reconnect-loop regression)', () => {
    const { controller, registry } = controllerWith({ REALTIME_ENABLED: false });
    let thrown: unknown;
    try {
      controller.stream(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.NO_CONTENT);
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('still opens a stream when real-time is enabled', () => {
    const { controller } = controllerWith({ REALTIME_ENABLED: true, REALTIME_MAX_CONNECTIONS_PER_USER: 3, NODE_ENV: 'test', REALTIME_HEARTBEAT_INTERVAL_MS: 30_000 });
    expect(() => controller.stream(request)).not.toThrow();
  });
});
