import { UPGRADE_INCOMPLETE_ENV, upgradeFailedMigration, upgradeStatusIndicator } from './upgrade-status';
import { UPGRADE_INCOMPLETE_VAR } from '../../../database/boot-checks/schema-compatibility';

/** O3 C3: /healthz names a failed upgrade migration as an informational field (status stays up / 200). */
describe('upgrade status (/healthz upgradeFailed)', () => {
  it('uses the same variable the API boot gate reads', () => {
    expect(UPGRADE_INCOMPLETE_ENV).toBe(UPGRADE_INCOMPLETE_VAR);
  });

  it('absent when the upgrade did not fail (unset or blank)', () => {
    expect(upgradeFailedMigration({})).toBeNull();
    expect(upgradeFailedMigration({ CREWFLOW_UPGRADE_INCOMPLETE: '' })).toBeNull();
    expect(upgradeStatusIndicator({})).toBeNull();
  });

  it('names the failed migration, always up (informational only)', () => {
    expect(upgradeStatusIndicator({ CREWFLOW_UPGRADE_INCOMPLETE: 'WorkspaceGrantParityGuards1786721430000' })).toEqual({
      upgrade: { status: 'up', upgradeFailed: 'WorkspaceGrantParityGuards1786721430000' },
    });
    expect(upgradeStatusIndicator({ CREWFLOW_UPGRADE_INCOMPLETE: 'unknown' })).toEqual({ upgrade: { status: 'up', upgradeFailed: 'unknown' } });
  });

  it('never echoes a value that is not a migration name', () => {
    for (const value of ['<script>alert(1)</script>', 'a b', 'x'.repeat(201), 'postgres://u:secret@h/db']) {
      expect(upgradeFailedMigration({ CREWFLOW_UPGRADE_INCOMPLETE: value })).toBe('unknown');
    }
  });
});
