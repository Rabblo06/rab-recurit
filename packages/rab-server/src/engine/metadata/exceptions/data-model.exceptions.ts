import { ForbiddenException, HttpStatus } from '@nestjs/common';

/**
 * Error codes of the data-model mutations (METADATA-API-CONTRACT §1.3 / §5). Phase 1 ships the two refusals the layer-2
 * service can already give; the rest arrive with the change runner (release 2).
 */
export const DataModelErrorCode = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  OBJECT_SYSTEM_LOCKED: 'OBJECT_SYSTEM_LOCKED',
} as const;

/**
 * 403: the caller may not change the data model — `data_model.manage` missing (role grants and per-user overrides, resolved
 * server-side), an Admin Inspect session (read-only), a worker context, or no organisation / workspace / user bound. The
 * data model of a workspace is visible to its members, so this is "exists, but you lack the permission" (CLAUDE.md: 403,
 * not 404).
 */
export class DataModelPermissionDeniedException extends ForbiddenException {
  constructor() {
    super({ statusCode: HttpStatus.FORBIDDEN, code: DataModelErrorCode.PERMISSION_DENIED, message: 'You do not have permission to change the data model.' });
  }
}

/**
 * 403: the target object is locked against data-model changes (the seven payroll / attendance tables, the junctions, D1 and
 * D4; M2-PLAN F12 / A6). The object is visible in metadata, so 403, not 404 (M2-PLAN §2.6 CF005).
 */
export class ObjectSystemLockedException extends ForbiddenException {
  constructor() {
    super({ statusCode: HttpStatus.FORBIDDEN, code: DataModelErrorCode.OBJECT_SYSTEM_LOCKED, message: 'This object is locked and its data model cannot be changed.' });
  }
}
