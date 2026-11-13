import { upgradeStatusIndicator } from './upgrade-status';

/**
 * OWNER-DB-ULTIMATE Part B3: /healthz carries the upgrade logbook's state (upgrade-status.service.ts) and whether the code
 * version's upgrade failed (informational: the status stays up / 200). Never a step name or an error message. The former
 * CREWFLOW_UPGRADE_INCOMPLETE signal is retired and has no effect here.
 */
describe('upgrade status (/healthz upgrade)', () => {
  it('ok / none / behind / ahead / unknown: upgradeFailed false; always up', () => {
    for (const state of ['ok', 'none', 'behind', 'ahead', 'unknown']) {
      expect(upgradeStatusIndicator(state)).toEqual({ upgrade: { status: 'up', upgradeFailed: false, upgrade: state } });
    }
    expect(upgradeStatusIndicator()).toEqual({ upgrade: { status: 'up', upgradeFailed: false } });
  });

  it('failed (only an upgrade command failed; the API serves): upgradeFailed true, still up', () => {
    expect(upgradeStatusIndicator('failed')).toEqual({ upgrade: { status: 'up', upgradeFailed: true, upgrade: 'failed' } });
  });

  it('the retired environment signal changes nothing', () => {
    const before = process.env.CREWFLOW_UPGRADE_INCOMPLETE;
    process.env.CREWFLOW_UPGRADE_INCOMPLETE = 'WorkspaceGrantParityGuards1786721430000';
    try {
      expect(JSON.stringify(upgradeStatusIndicator('ok'))).toBe('{"upgrade":{"status":"up","upgradeFailed":false,"upgrade":"ok"}}');
    } finally {
      if (before === undefined) delete process.env.CREWFLOW_UPGRADE_INCOMPLETE;
      else process.env.CREWFLOW_UPGRADE_INCOMPLETE = before;
    }
  });
});
