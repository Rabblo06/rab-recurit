import { UPGRADE_INCOMPLETE_ENV, upgradeFailed, upgradeStatusIndicator } from './upgrade-status';
import { UPGRADE_INCOMPLETE_VAR } from '../../../database/boot-checks/schema-compatibility';

/**
 * O3 C3: /healthz says WHETHER the last upgrade failed (informational, status stays up / 200) and never WHICH migration
 * (coordinator decision 2026-11-05: the name stays in the start-up logs only).
 */
describe('upgrade status (/healthz upgradeFailed)', () => {
  it('uses the same variable the API boot gate reads', () => {
    expect(UPGRADE_INCOMPLETE_ENV).toBe(UPGRADE_INCOMPLETE_VAR);
  });

  it('false when the upgrade did not fail (unset or blank); always up', () => {
    expect(upgradeFailed({})).toBe(false);
    expect(upgradeFailed({ CREWFLOW_UPGRADE_INCOMPLETE: '' })).toBe(false);
    expect(upgradeStatusIndicator({})).toEqual({ upgrade: { status: 'up', upgradeFailed: false } });
  });

  it('true after a failed upgrade, still up (informational only)', () => {
    expect(upgradeStatusIndicator({ CREWFLOW_UPGRADE_INCOMPLETE: 'WorkspaceGrantParityGuards1786721430000' })).toEqual({
      upgrade: { status: 'up', upgradeFailed: true },
    });
    expect(upgradeStatusIndicator({ CREWFLOW_UPGRADE_INCOMPLETE: 'unknown' })).toEqual({ upgrade: { status: 'up', upgradeFailed: true } });
  });

  it('never exposes the migration name or any other value', () => {
    for (const value of ['WorkspaceGrantParityGuards1786721430000', '<script>alert(1)</script>', 'postgres://u:secret@h/db']) {
      const payload = JSON.stringify(upgradeStatusIndicator({ CREWFLOW_UPGRADE_INCOMPLETE: value }));
      expect(payload).toBe('{"upgrade":{"status":"up","upgradeFailed":true}}');
      expect(payload).not.toContain(value);
    }
  });
});
