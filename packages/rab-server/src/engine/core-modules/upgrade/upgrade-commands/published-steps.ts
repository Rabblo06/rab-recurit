/**
 * Security review of the 0.7.0 release PR, L1: the step names of each published (or being-published) version's sequence,
 * pinned and APPEND-ONLY. upgrade-sequence.spec.ts fails when the registry no longer produces exactly these steps for a version
 * in CREWFLOW_PREVIOUS_VERSIONS or for the code version: removing or renaming a release's command (for example dropping
 * UPGRADE_COMMANDS['0-7'] and with it the HWS cutover) would otherwise make a version look complete without the step ever
 * having run. A version still being prepared may gain steps until it is published; once published its list never changes.
 */
export const PUBLISHED_VERSION_STEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0.4.0': Object.freeze(['0.4.0_TypeOrmMigrations']),
  '0.5.0': Object.freeze(['0.5.0_TypeOrmMigrations']),
  '0.6.0': Object.freeze([
    '0.6.0_TypeOrmMigrations',
    '0.6.0_StaffProfileMemberSelect_1786721480000',
    '0.6.0_DropWorkspaceCoreForeignKeys_1786721530000',
    '0.6.0_SyncStandardObjects_1786721900000',
  ]),
  '0.7.0': Object.freeze([
    '0.7.0_TypeOrmMigrations',
    '0.7.0_HwsCutover_1786721540100',
    '0.7.0_ValidateStaffProfileWorkspaceRequired_1786721595000',
    '0.7.0_ShiftTeamSelectMultiRole_1786721600000',
    '0.7.0_AttendanceStaffScope_1786722120000',
    '0.7.0_AttendanceCorrectionInsertOnly_1786722130000',
  ]),
});
