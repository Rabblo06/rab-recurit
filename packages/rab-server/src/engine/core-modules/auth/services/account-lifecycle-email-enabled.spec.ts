import { AccountLifecycleService } from './account-lifecycle.service';

/**
 * Phase D-Q owner decision "always queue": whether a Staff/Manager invite is queued depends ONLY on the
 * EMAIL_DELIVERY_ENABLED configuration — never on Worker health (the Redis heartbeat). The service no longer has a Redis
 * dependency at all, so a Redis outage can neither skip nor slow invite creation.
 */
describe('AccountLifecycleService.isEmailDeliveryEnabled (always queue)', () => {
  const build = (value: unknown) => {
    const env = {
      get: jest.fn((key: string) =>
        key === 'EMAIL_DELIVERY_ENABLED' ? value : undefined,
      ),
    };
    const none = undefined as never;
    return {
      service: new AccountLifecycleService(
        none,
        none,
        none,
        none,
        none,
        none,
        env as never,
        none,
      ),
      env,
    };
  };

  it('is true when EMAIL_DELIVERY_ENABLED is true, regardless of any Worker heartbeat', () => {
    const { service, env } = build(true);
    expect(service.isEmailDeliveryEnabled()).toBe(true);
    expect(env.get).toHaveBeenCalledWith('EMAIL_DELIVERY_ENABLED');
  });

  it('is false when EMAIL_DELIVERY_ENABLED is false (operator kill switch, unchanged)', () => {
    expect(build(false).service.isEmailDeliveryEnabled()).toBe(false);
  });

  it('fails closed on anything but a real boolean true', () => {
    for (const v of ['true', 1, undefined, null])
      expect(build(v).service.isEmailDeliveryEnabled()).toBe(false);
  });

  it('is synchronous (no Redis round trip that could fail or stall the request)', () => {
    const result = build(true).service.isEmailDeliveryEnabled();
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('the constructor takes no Redis client any more (the heartbeat dependency is gone)', () => {
    expect(AccountLifecycleService.length).toBe(8);
  });
});
