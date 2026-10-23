import { PermissionFlag, PermissionFlagType } from '@rab/shared';

/**
 * Wave 5 lane DATA — field-level read policy for the FINANCIAL / ATTENDANCE read DTOs (attendance list, shift report
 * seats, payroll records and payroll-run views/exports).
 *
 * Kept deliberately separate from `MEMBER_OBJECTS` (member-object-registry.ts): that registry drives the Settings →
 * Roles editor and materialises "See" grants into route flags; adding `attendance` / `payroll_record` there would let a
 * custom-member role ask for `attendance.view` / `payroll.view`, which `MEMBER_ROLE_ALLOWED_PERMISSIONS` (and the
 * `role_permission_member_allowlist` trigger) refuse — an owner decision, not something this lane may widen.
 *
 * This file is the ONLY place that names which response properties / CSV columns belong to which field, and which
 * permission a caller must currently hold for the field to be present at all. Nothing a client sends is ever used as a
 * key here. A field is resolved per request, server-side (FieldPolicyService) — never read off a token or the client.
 *
 * Rule (owner brief, wave 5): "pay visibility follows the existing payroll.view semantics". So every money field has
 * `sensitiveAuthority: payroll.view` — a caller without it (today: the system `venue_manager` role, staff, custom
 * members) never receives the property, never filters or sorts by it, never sees it in an export. Worked time is not
 * money: it stays visible to whoever may read the record (the Venue Manager reviews attendance), but is a configurable
 * field so a future member-role rule (role_field_permission) can hide it.
 */
export type FieldPolicyObjectKey = 'attendance' | 'payroll_record';
export const FIELD_POLICY_OBJECT_KEYS: readonly FieldPolicyObjectKey[] = ['attendance', 'payroll_record'];

export interface FieldPolicyField {
  key: string;
  label: string;
  /** Response properties this field controls (removed from the serialised object when hidden). */
  properties: readonly string[];
  /** The caller must hold this flag RIGHT NOW for the field to be visible (no flag ⇒ visible to any reader). */
  sensitiveAuthority?: PermissionFlagType;
  /** Default for a custom workspace-member when no role_field_permission row exists (least privilege for money). */
  memberDefaultVisible: boolean;
}

export interface FieldPolicyObject {
  key: FieldPolicyObjectKey;
  /** Route flag a caller needs to read the object at all (informational; the routes' PermissionGuard enforces it). */
  readFlag: PermissionFlagType;
  fields: readonly FieldPolicyField[];
}

export const FIELD_POLICY_OBJECTS: Record<FieldPolicyObjectKey, FieldPolicyObject> = {
  attendance: {
    key: 'attendance',
    readFlag: PermissionFlag.ATTENDANCE_VIEW,
    fields: [
      { key: 'workedTime', label: 'Worked time', properties: ['workedMinutes'], memberDefaultVisible: true },
      {
        key: 'earnings',
        label: 'Earnings',
        properties: ['earnedPence', 'payrollApprovedPence', 'payRatePence', 'payRateSnapshotPence'],
        sensitiveAuthority: PermissionFlag.PAYROLL_VIEW,
        memberDefaultVisible: false,
      },
    ],
  },
  payroll_record: {
    key: 'payroll_record',
    readFlag: PermissionFlag.PAYROLL_VIEW,
    fields: [
      { key: 'workedTime', label: 'Worked time', properties: ['workedMinutes', 'minutes', 'hours'], memberDefaultVisible: true },
      { key: 'payRate', label: 'Pay rate', properties: ['payRatePence', 'defaultRatePence'], sensitiveAuthority: PermissionFlag.PAYROLL_VIEW, memberDefaultVisible: false },
      {
        key: 'amount',
        label: 'Gross amount',
        properties: ['amountPence', 'grossPence', 'approvedPence', 'netPence'],
        sensitiveAuthority: PermissionFlag.PAYROLL_VIEW,
        memberDefaultVisible: false,
      },
    ],
  },
};

export function fieldPolicyObject(key: string): FieldPolicyObject | null {
  return (FIELD_POLICY_OBJECTS as Record<string, FieldPolicyObject>)[key] ?? null;
}
