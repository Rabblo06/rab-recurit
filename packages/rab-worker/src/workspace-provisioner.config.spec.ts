import {
  PROVISIONER_INTERVAL_DEFAULT_SECONDS,
  PROVISIONER_INTERVAL_MAX_SECONDS,
  PROVISIONER_INTERVAL_MIN_SECONDS,
  ProvisionerConfigError,
  resolveInProcessProvisioningInterval,
} from './workspace-provisioner.config';

/** The in-process provisioning interval (T4). Pure: no database, no Redis. */
describe('resolveInProcessProvisioningInterval', () => {
  it('interval: default 60 s; whole seconds 5..120 accepted; everything else refused (fail closed, value never echoed)', () => {
    expect(PROVISIONER_INTERVAL_DEFAULT_SECONDS).toBe(60);
    expect(PROVISIONER_INTERVAL_MIN_SECONDS).toBe(5);
    expect(PROVISIONER_INTERVAL_MAX_SECONDS).toBe(120);
    expect(resolveInProcessProvisioningInterval({})).toEqual({ intervalSeconds: 60, intervalMs: 60_000 });
    expect(resolveInProcessProvisioningInterval({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '' }).intervalSeconds).toBe(60);
    for (const ok of ['5', '30', ' 45 ', '120']) {
      expect(resolveInProcessProvisioningInterval({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: ok }).intervalMs).toBe(Number(ok.trim()) * 1000);
    }
    for (const bad of ['0', '4', '121', '86400', '-5', '5.5', '1e2', '60s', 'sixty', '0x10', 'S3cretValue']) {
      let error: unknown;
      try {
        resolveInProcessProvisioningInterval({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: bad });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProvisionerConfigError);
      expect((error as Error).message).toMatch(/^WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from 5 to 120/);
    }
    let message = '';
    try {
      resolveInProcessProvisioningInterval({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: 'S3cretValue' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('S3cretValue');
  });

  it('X5.1: the standalone provisioner switch is gone; the interval does not depend on CREWFLOW_PROVISIONER_ENABLED or HWS_RUNTIME_ENABLED', () => {
    expect(Object.keys(jest.requireActual<object>('./workspace-provisioner.config'))).not.toContain('resolveProvisionerConfig');
    for (const extra of [{ CREWFLOW_PROVISIONER_ENABLED: 'false' }, { HWS_RUNTIME_ENABLED: 'true' }, { HWS_RUNTIME_ENABLED: 'false', NODE_ENV: 'production' }]) {
      expect(resolveInProcessProvisioningInterval(extra)).toEqual({ intervalSeconds: 60, intervalMs: 60_000 });
    }
  });
});
