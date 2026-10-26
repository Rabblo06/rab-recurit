import { PermissionFlag } from '@rab/shared';

import { ROLE_DEFS } from '../../../modules/manager/services/manager.service';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../../../modules/staff/services/staff.service';
import {
  PERMISSION_CATALOGUE_1786718000000,
  SYSTEM_ROLE_DEFAULTS_1786718000000,
} from './migrations/1786718000000-PermissionCatalogueAndSystemRoleDefaults';
import { SYSTEM_ROLE_DEFAULT_ADDITIONS_1786718900000 } from './migrations/1786718900000-ManagerPayrollApproveDefault';
import { SYSTEM_ROLE_DEFAULT_ADDITIONS_1786719300000 } from './migrations/1786719300000-ManagerMarkPaidInitialManagerCalendar';
import { SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720000000 } from './migrations/1786720000000-SettingsViewLeadershipDefault';
import { SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720210000 } from './migrations/1786720210000-AiUsePermissionDefault';
import { SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720240000 } from './migrations/1786720240000-AiSettingsPermission';
import { SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720600000 } from './migrations/1786720600000-AiAgentsPermission';

/** The 1786718000000 snapshot plus every later default-adding migration (frozen migrations are never edited). */
const MIGRATED_SYSTEM_ROLE_DEFAULTS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(SYSTEM_ROLE_DEFAULTS_1786718000000).map(([role, flags]) => [role, [...flags, ...(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786718900000[role] ?? []), ...(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786719300000[role] ?? []), ...(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720000000[role] ?? []), ...(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720210000[role] ?? []), ...(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720240000[role] ?? []), ...(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720600000[role] ?? [])]]),
);

/**
 * The permission catalogue is a schema contract (recurring-403 root cause, 2026-10-15): a database built from migrations
 * alone must hold every PermissionFlag, and every system role's code defaults must be restorable by a migration. These
 * fail the moment a flag or a system-role default changes in code without a migration that ships it.
 */
describe('permission catalogue is created by migrations, not by seed scripts', () => {
  it('the migration catalogue covers every PermissionFlag (add a migration when you add a flag)', () => {
    // Flags added after the 1786718000000 snapshot, each by its own migration.
    const LATER_FLAGS = ['ai.use', 'ai.settings', 'ai.agents.manage']; // AiUsePermissionDefault1786720210000, AiSettingsPermission1786720240000, AiAgentsPermission1786720600000
    expect([...PERMISSION_CATALOGUE_1786718000000, ...LATER_FLAGS].sort()).toEqual(Object.values(PermissionFlag).sort());
  });

  it('ai.use is a default of the CEO and Manager system roles only; never Venue Manager or Staff (AI Phase 1)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.AI_USE)).map(([role]) => role).sort();
    expect(holders).toEqual(['ceo', 'manager']);
  });

  it('ai.settings is a default of the CEO system role only; never Manager, Venue Manager or Staff (AI Phase 1 real models, D6)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.AI_SETTINGS)).map(([role]) => role);
    expect(holders).toEqual(['ceo']);
  });

  it('ai.agents.manage is a default of the CEO system role only; never Manager, Venue Manager or Staff (AI Phase 6a, P6-D12)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.AI_AGENTS_MANAGE)).map(([role]) => role);
    expect(holders).toEqual(['ceo']);
  });

  it('system-role defaults in the migration equal the code defaults (ROLE_DEFS + Staff)', () => {
    const fromCode: Record<string, string[]> = { [STAFF_ROLE_KEY]: [...STAFF_ROLE_PERMISSIONS].sort() };
    for (const def of Object.values(ROLE_DEFS)) fromCode[def.key] = [...def.permissions].sort();
    const fromMigration = Object.fromEntries(Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).map(([k, v]) => [k, [...v].sort()]));
    expect(fromMigration).toEqual(fromCode);
  });

  it('payroll.approve is a default of the Manager role only — never Venue Manager, Staff or CEO (owner decision 2026-10-20)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.PAYROLL_APPROVE)).map(([role]) => role);
    expect(holders).toEqual(['manager']);
  });

  it('payroll.mark_paid is a default of the Manager role only (owner decision 2026-10-21)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.PAYROLL_MARK_PAID)).map(([role]) => role);
    expect(holders).toEqual(['manager']);
  });

  it('settings.edit is held by NO system role — organisation settings are changed by a platform administrator only (owner decision 2026-10-23, W6-E2E-04)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.SETTINGS_EDIT)).map(([role]) => role);
    expect(holders).toEqual([]);
  });

  it('settings.view (read-only organisation settings) is a default of the CEO and Manager roles only (W6-E2E-04)', () => {
    const holders = Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS).filter(([, flags]) => flags.includes(PermissionFlag.SETTINGS_VIEW)).map(([role]) => role).sort();
    expect(holders).toEqual(['ceo', 'manager']);
  });

  it('every system-role default is itself in the catalogue', () => {
    const catalogue = new Set([...PERMISSION_CATALOGUE_1786718000000, 'ai.use', 'ai.settings', 'ai.agents.manage']);
    for (const [role, flags] of Object.entries(MIGRATED_SYSTEM_ROLE_DEFAULTS)) {
      expect([role, flags.filter((f) => !catalogue.has(f))]).toEqual([role, []]);
    }
  });
});
