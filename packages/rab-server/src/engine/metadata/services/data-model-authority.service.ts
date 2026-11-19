import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../core-modules/permissions/permissions.service';
import { AuthContext } from '../../core-modules/tenant/auth-context.interface';
import { DataModelPermissionDeniedException, ObjectSystemLockedException } from '../exceptions/data-model.exceptions';
import { NO_CUSTOM_FIELD_TABLES } from '../standard-objects/standard-object-plan';

/**
 * Metadata engine M2, phase 1 (docs/plans/phase-x4/M2-PLAN.md §2.1 "Service (layer 2)", PR-1; owner decision 2026-11-18:
 * "DATA_MODEL as a role permission checked in the service"): the ONE place every data-model write path re-checks its
 * authority, inside the caller's own tenant transaction — so the change runner, a job or a CLI command that calls a
 * metadata write service directly (never passing a guard) meets the same rule as the release-2 API, where
 * `PermissionGuard(PermissionFlag.DATA_MODEL_MANAGE)` adds layer 1 on the handler.
 *
 * Release 1 (API off) has no caller yet: this ships the rule, its abuse tests and the locked-object list first, so the
 * runner (PR-8) and the API (PR-9) can only be built on top of it. Every refusal throws — never a boolean a caller could
 * forget to check — and a failing permission lookup propagates (the write is refused, fail closed).
 */
@Injectable()
export class DataModelAuthorityService {
  constructor(private readonly permissions: PermissionsService) {}

  /**
   * Layer 2: the caller may change this workspace's data model. Refused (403 PERMISSION_DENIED), in this order, before any
   * permission query:
   *   - no context, or no organisation / workspace / user bound (a data model belongs to one workspace);
   *   - an Admin Inspect session (`inspectedBy`: read-only, the same rule PermissionGuard applies to every non-GET);
   *   - a worker context (`actorType = 'worker'`: system scans never change the data model; M2-PLAN A9);
   * then `data_model.manage` is re-read from PostgreSQL in THIS transaction (role grants of the bound user, per-user
   * overrides winning: PermissionsService.userHasPermissionTx), never from the JWT or the request snapshot.
   */
  async assertCanManageDataModelTx(manager: EntityManager, ctx: AuthContext | undefined): Promise<void> {
    if (!ctx || !ctx.organisationId || !ctx.workspaceId || !ctx.userId) throw new DataModelPermissionDeniedException();
    if (ctx.inspectedBy) throw new DataModelPermissionDeniedException();
    if (ctx.actorType === 'worker') throw new DataModelPermissionDeniedException();
    const allowed = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.DATA_MODEL_MANAGE);
    if (allowed !== true) throw new DataModelPermissionDeniedException();
  }

  /**
   * Owner decision 2026-11-18 ("Payroll/attendance objects locked"; M2-PLAN F12 / A6): the target table of a data-model
   * change must not be locked. Checked by physical TABLE NAME, before any metadata flag is looked at, so a forged
   * `is_system = false` / `allows_custom_fields = true` metadata row cannot unlock it. The list is the engine's
   * NO_CUSTOM_FIELD_TABLES: the seven payroll / attendance tables (also pinned to system in the database by M1), the
   * junctions `venue_manager_staff`, `manager_venue`, `shift_request_staff`, D1 `venue_role_rate`, `shift_assignment`, and
   * D4 `shift_report`, `replacement_request`, `user_note`. Refused with 403 OBJECT_SYSTEM_LOCKED (the object is visible in
   * metadata, so not 404). A name that is not a plain identifier is refused the same way (fail closed).
   */
  assertObjectNotLocked(physicalTable: string): void {
    if (typeof physicalTable !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(physicalTable)) throw new ObjectSystemLockedException();
    if (DATA_MODEL_LOCKED_TABLES.has(physicalTable)) throw new ObjectSystemLockedException();
  }
}

/** The locked tables (see assertObjectNotLocked). A frozen set built from the engine's own list, never a second copy. */
export const DATA_MODEL_LOCKED_TABLES: ReadonlySet<string> = new Set(NO_CUSTOM_FIELD_TABLES);
