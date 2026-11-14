import { upgradeStatusIndicator } from './upgrade-status';
import { upgradeCard } from '../platform-admin/admin-health.service';
import type { UpgradeStatus } from '../upgrade/upgrade-status.service';

/**
 * Owner decision 2026-11-14 (OWNER-DB-ULTIMATE Part B): public /healthz carries ONLY `upgradeFailed: true | false`. No
 * version, step name, state word or error text in any state; the detail stays on the platform-admin health report.
 */
const STATES = ['ok', 'failed', 'behind', 'ahead', 'none', 'unknown'] as const;
const DETAIL: Omit<UpgradeStatus, 'state'> = {
  appVersion: '0.6.0',
  step: '0.6.0_FixThing_1786799990000',
  executedByVersion: '0.6.0',
  attempt: 2,
  forced: false,
  at: '2026-11-14T00:00:00.000Z',
};
const FORBIDDEN = ['0.6.0', 'FixThing', 'TypeOrmMigrations', 'behind', 'ahead', 'none', 'unknown', 'ok"', 'error', 'Error', 'step', 'version', 'attempt'];

describe('public /healthz upgrade indicator: a boolean only', () => {
  it.each(STATES)('state %s: exactly { status: up, upgradeFailed } and nothing else', (state) => {
    const body = upgradeStatusIndicator(state);
    expect(body).toEqual({ upgrade: { status: 'up', upgradeFailed: state === 'failed' } });
    const text = JSON.stringify(body);
    for (const word of FORBIDDEN) expect(text).not.toContain(word);
  });

  it('no state known (the status service unavailable): upgradeFailed false, still up', () => {
    expect(upgradeStatusIndicator()).toEqual({ upgrade: { status: 'up', upgradeFailed: false } });
  });

  it('the retired environment signal changes nothing', () => {
    const before = process.env.CREWFLOW_UPGRADE_INCOMPLETE;
    process.env.CREWFLOW_UPGRADE_INCOMPLETE = 'WorkspaceGrantParityGuards1786721430000';
    try {
      expect(upgradeStatusIndicator('ok')).toEqual({ upgrade: { status: 'up', upgradeFailed: false } });
    } finally {
      if (before === undefined) delete process.env.CREWFLOW_UPGRADE_INCOMPLETE;
      else process.env.CREWFLOW_UPGRADE_INCOMPLETE = before;
    }
  });

  it.each(STATES)('the admin health report keeps the detail (state %s)', (state) => {
    const card = upgradeCard({ ...DETAIL, state });
    expect(card.key).toBe('upgrade');
    if (state === 'unknown') expect(card.detail).toBe('Upgrade status not readable.');
    else if (state === 'none') expect(card.detail).toContain('0.6.0');
    else expect(card.detail).toContain('0.6.0_FixThing_1786799990000');
  });
});
