import { EntityManager } from 'typeorm';

import { Permission } from '../entities';

/**
 * Loads the catalogue rows for a SYSTEM role's code-defined default permissions — and refuses if any are missing.
 *
 * Every system-role creation path (ManagerService.ensureRole, StaffService.ensureStaffRole, the bootstrap-admin command)
 * used to intersect its defaults with whatever `core.permission` held and carry on. On a database whose catalogue was
 * incomplete (built from migrations before PermissionCatalogueAndSystemRoleDefaults1786718000000) that silently created
 * roles with most of their permissions missing, and the only symptom was a wall of 403s later. Failing here, at the moment
 * of creation, names the real problem instead of minting a crippled role.
 */
export async function loadSystemRoleDefaultPermissions(
  manager: EntityManager,
  roleKey: string,
  keys: readonly string[],
): Promise<Permission[]> {
  if (keys.length === 0) return [];
  const permissions = await manager
    .createQueryBuilder(Permission, 'p')
    .where('p.key IN (:...keys)', { keys: [...keys] })
    .getMany();
  const found = new Set(permissions.map((p) => p.key));
  const missing = keys.filter((key) => !found.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Permission catalogue is incomplete: system role "${roleKey}" needs ${missing.join(', ')}. ` +
        'Apply the reviewed migrations (PermissionCatalogueAndSystemRoleDefaults1786718000000); never create the role without them.',
    );
  }
  return permissions;
}
