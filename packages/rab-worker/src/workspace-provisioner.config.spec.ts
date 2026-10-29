import {
  PROVISIONER_INTERVAL_DEFAULT_SECONDS,
  PROVISIONER_INTERVAL_LEGACY_DEFAULT_SECONDS,
  PROVISIONER_INTERVAL_MAX_SECONDS,
  PROVISIONER_INTERVAL_MIN_SECONDS,
  ProvisionerConfigError,
  resolveProvisionerConfig,
} from './workspace-provisioner.config';

/**
 * Phase A (pa-provisioner): the provisioner entrypoint's start-up switch and interval. Pure — no database, no Redis.
 * The bundle-level opt-in (only start the child when CREWFLOW_PROVISIONER_ENABLED=true) is covered by
 * packages/rab-docker/rab/worker-bundle/test/launcher.test.cjs; this covers what the child itself decides.
 */
describe('resolveProvisionerConfig (Phase A)', () => {
  it('explicit opt-in provisions regardless of HWS_RUNTIME_ENABLED (production runs routing OFF and still needs the reconciler)', () => {
    for (const hws of [undefined, 'false', 'true', '']) {
      const c = resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: 'true', HWS_RUNTIME_ENABLED: hws });
      expect(c.provision).toBe(true);
      expect(c.enabledBy).toBe('CREWFLOW_PROVISIONER_ENABLED');
      expect(c.hwsRuntimeEnabled).toBe(hws ?? null); // passed through, never rewritten
    }
  });

  it('explicit opt-out never provisions, even with HWS_RUNTIME_ENABLED=true', () => {
    const c = resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: 'false', HWS_RUNTIME_ENABLED: 'true' });
    expect(c.provision).toBe(false);
    expect(c.enabledBy).toBeNull();
  });

  it('unset switch keeps the legacy standalone gate: provision only when HWS_RUNTIME_ENABLED is exactly "true"', () => {
    expect(resolveProvisionerConfig({ HWS_RUNTIME_ENABLED: 'true' })).toMatchObject({ provision: true, enabledBy: 'HWS_RUNTIME_ENABLED' });
    expect(resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: '', HWS_RUNTIME_ENABLED: 'true' }).provision).toBe(true);
    for (const hws of [undefined, 'false', 'TRUE', '1', '']) {
      expect(resolveProvisionerConfig({ HWS_RUNTIME_ENABLED: hws }).provision).toBe(false);
    }
  });

  it('an invalid switch value refuses to start (fail closed) and never echoes the value', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', 'ture']) {
      let error: unknown;
      try {
        resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: v, HWS_RUNTIME_ENABLED: 'true' });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProvisionerConfigError);
      expect((error as Error).message).toMatch(/^CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"/);
      expect((error as Error).message).not.toContain(`"${v}"`);
    }
    expect(resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: ' true ' }).provision).toBe(true);
  });

  it('interval: default 60 s; whole seconds 5..120 accepted; everything else refused', () => {
    expect(PROVISIONER_INTERVAL_DEFAULT_SECONDS).toBe(60);
    expect(PROVISIONER_INTERVAL_MIN_SECONDS).toBe(5);
    expect(PROVISIONER_INTERVAL_MAX_SECONDS).toBe(120);
    expect(resolveProvisionerConfig({})).toMatchObject({ intervalSeconds: 60, intervalMs: 60_000 });
    expect(resolveProvisionerConfig({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '' }).intervalSeconds).toBe(60);
    for (const ok of ['5', '30', ' 45 ', '120']) {
      expect(resolveProvisionerConfig({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: ok }).intervalMs).toBe(Number(ok.trim()) * 1000);
    }
    for (const bad of ['0', '4', '121', '86400', '-5', '5.5', '1e2', '60s', 'sixty', '0x10']) {
      expect(() => resolveProvisionerConfig({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: bad })).toThrow(
        /^WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from 5 to 120/,
      );
    }
  });

  it('legacy HWS gate (switch unset) keeps the pre-Phase-A 5 s cadence unless the interval is set; the explicit switch gets 60 s', () => {
    expect(PROVISIONER_INTERVAL_LEGACY_DEFAULT_SECONDS).toBe(5);
    expect(resolveProvisionerConfig({ HWS_RUNTIME_ENABLED: 'true' })).toMatchObject({ provision: true, intervalSeconds: 5, intervalMs: 5_000 });
    expect(resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: '', HWS_RUNTIME_ENABLED: 'true' }).intervalSeconds).toBe(5);
    expect(resolveProvisionerConfig({ HWS_RUNTIME_ENABLED: 'true', WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '30' }).intervalSeconds).toBe(30);
    expect(resolveProvisionerConfig({ CREWFLOW_PROVISIONER_ENABLED: 'true', HWS_RUNTIME_ENABLED: 'true' }).intervalSeconds).toBe(60);
  });

  it('validates the interval even when not provisioning, so a bad value is reported rather than silently ignored', () => {
    expect(() => resolveProvisionerConfig({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '0' })).toThrow(ProvisionerConfigError);
  });
});
