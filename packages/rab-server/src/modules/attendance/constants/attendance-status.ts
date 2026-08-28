/**
 * Kept out of `entities/index.ts`'s barrel export — `core.datasource.ts`
 * spreads `Object.values(attendanceEntities)` straight into TypeORM's
 * `entities` array, so anything else exported from that barrel (a plain
 * const object, not an entity class) breaks that assignment.
 */
export const AttendanceStatus = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
} as const;
export type AttendanceStatusType = (typeof AttendanceStatus)[keyof typeof AttendanceStatus];
