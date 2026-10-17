import { PermissionFlag } from '@rab/shared';

import { ROLE_DEFS } from '../../../modules/manager/services/manager.service';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../../../modules/staff/services/staff.service';
import {
  PERMISSION_CATALOGUE_1786718000000,
  SYSTEM_ROLE_DEFAULTS_1786718000000,
} from './migrations/1786718000000-PermissionCatalogueAndSystemRoleDefaults';

/**
 * The permission catalogue is a schema contract (recurring-403 root cause, 2026-10-15): a database built from migrations
 * alone must hold every PermissionFlag, and every system role's code defaults must be restorable by a migration. These
 * fail the moment a flag or a system-role default changes in code without a migration that ships it.
 */
describe('permission catalogue is created by migrations, not by seed scripts', () => {
  it('the migration catalogue covers every PermissionFlag (add a migration when you add a flag)', () => {
    expect([...PERMISSION_CATALOGUE_1786718000000].sort()).toEqual(Object.values(PermissionFlag).sort());
  });

  it('system-role defaults in the migration equal the code defaults (ROLE_DEFS + Staff)', () => {
    const fromCode: Record<string, string[]> = { [STAFF_ROLE_KEY]: [...STAFF_ROLE_PERMISSIONS].sort() };
    for (const def of Object.values(ROLE_DEFS)) fromCode[def.key] = [...def.permissions].sort();
    const fromMigration = Object.fromEntries(Object.entries(SYSTEM_ROLE_DEFAULTS_1786718000000).map(([k, v]) => [k, [...v].sort()]));
    expect(fromMigration).toEqual(fromCode);
  });

  it('every system-role default is itself in the catalogue', () => {
    const catalogue = new Set(PERMISSION_CATALOGUE_1786718000000);
    for (const [role, flags] of Object.entries(SYSTEM_ROLE_DEFAULTS_1786718000000)) {
      expect([role, flags.filter((f) => !catalogue.has(f))]).toEqual([role, []]);
    }
  });
});
