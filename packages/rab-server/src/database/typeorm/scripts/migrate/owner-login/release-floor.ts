/**
 * Phase X U-1 (owner decisions 2026-11-11, P1-1 / P1-2 / P1-3): the UPGRADE FLOOR. It replaces the N1 production approval
 * list (core/production-migration-approval.ts) on the owner-login path of the locked runner only. N1 stays, unchanged, on
 * the legacy CF-41 path and the CLI (GuardedMigrationDataSource) until the clean-up PR retires those paths (P1-4).
 *
 * Why: N1 refused every pending migration after its 2026-10-22 cutoff, so every upgrade of an EXISTING production database
 * (one with tenant rows; a proven fresh install was waived) refused with exit 65 and a restart loop (finding SU-01 /
 * XD-01). The floor instead asks one question: is this database's history at or past a release we support upgrading from?
 *
 * A release is identified by its MIGRATION SET, never by a tag or an environment value (SU-05: there is no trustworthy
 * runtime release identity; the migration list is the only intrinsic one). RELEASE_MANIFESTS is frozen: each entry records
 * the exact ordered class names, their count, the last name and the sha256 of the names joined by '\n'. The spec
 * (release-floor.spec.ts) proves each recorded set against its hash, that each is a prefix of the next, and that the newest
 * equals this code's migrations directory.
 *
 *   R254  rab/v0.4.0 (e1b1132a), cd7c7e32 (published adolphus:cd7c7e32…), 4c38aa1a: 254 migrations, last
 *         WorkspaceGrantParityGuards1786721430000. One set, three commits: a ledger cannot tell them apart and need not.
 *   R256  0e0a6edd (Phase D, published sha256:d7750043…) = main at 3df7855c: R254 + OutboxClaimIndexes1786721440000 +
 *         RefreshTokenReplacedByIndex1786721450000.
 *
 * The decision (assertSupportedUpgradeStart), on the LOCKED migration session, after the classifier and the owner-login
 * identity rule, before F5 and before anything is applied:
 *   - target local / test                         unrestricted, exactly as N1 was (the CI lifecycle harnesses build
 *                                                  behind-head databases there on purpose); an unknown target is checked;
 *   - a proven fresh install                       allowed (the full chain; unchanged owner rule);
 *   - CURRENT, AHEAD                               allowed: nothing is pending (AHEAD = an image rollback, warned, C-1);
 *   - CHAIN-PARTIAL, not fresh                     allowed only when the ledger contains every name of a SUPPORTED release
 *                                                  and everything beyond it is a contiguous run of this code's chain
 *                                                  (exactly the current release, or a partial upgrade being resumed);
 *   - anything else (an older history, a history   refused: UnsupportedUpgradeStartError, mapped to outcome `behind`
 *     with holes, unknown names, EMPTY or           (exit 65) in migrate-on-start.ts outcomeOf, so it fails closed under
 *     BOOTSTRAP-PARTIAL that is not fresh,          every CREWFLOW_UPGRADE_FAILURE policy (C3 unchanged). Nothing is
 *     FOREIGN)                                      applied; the ledger and the data are untouched.
 * There is NO override (owner decision P1-3: none in this item). A database below the floor is upgraded with a release of
 * the floor first, or (a separated-layout database without the ROW_COPY trio) through
 * packages/rab-docker/docs/release/OWNER-LOGIN-RECOVERY.md.
 *
 * Adding a release: append a manifest whose names are the previous release's names plus the new ones (never edit an
 * existing entry) AND add its id to SUPPORTED_UPGRADE_FROM in the same change: every release at or after the oldest
 * supported one must be listed, or every database of that release is refused (exit 65). The spec fails the day one is
 * forgotten. Only MOVING THE FLOOR (dropping the oldest supported release) is an owner decision.
 *
 * Pure; importing this module has no side effects.
 */
import { createHash } from 'node:crypto';

import type { DbTarget } from '../../../core/database-target';
import type { DatabaseInstallState } from './fresh-install';

export interface ReleaseManifest {
  /** R<count>: named by the size of its migration set. */
  id: string;
  /** The commits and tags that ship exactly this set (documentation; never read at runtime). */
  refs: readonly string[];
  count: number;
  last: string;
  /** sha256 (hex) of `names.join('\n')`. */
  sha256: string;
  names: readonly string[];
}

/** R254: the migration set of rab/v0.4.0 = cd7c7e32 = 4c38aa1a (verified with git ls-tree on 2026-11-11). */
const R254_NAMES: readonly string[] = Object.freeze([
  'InitSchema1786665600000', 'TenantSessionContext1786665700000', 'IdentitySchema1786665800000',
  'OperationalSchema1786665900000', 'SchedulingSchema1786666000000', 'OfferConfirmationSchema1786666100000',
  'AccountLifecycleSchema1786666200000', 'OfferBatchNotificationSchema1786666300000', 'ShiftAddressColumn1786666400000',
  'SettingsSchema1786666500000', 'OrganisationMemberSchema1786666600000', 'ResourceOwnershipSchema1786666700000',
  'ManagerTypeCeo1786666800000', 'AdminInspectSessionSchema1786666900000', 'AttendanceSchema1786667000000',
  'ManagerWorkspaceSchema1786667100000', 'VenueJobRoleOwnershipSchema1786667200000', 'UserEmailLoginIndex1786667300000',
  'PreAuthLookupFunctions1786667400000', 'LoginHistoryLockoutIndex1786667500000', 'WorkspaceIdExpand1786667600000',
  'WorkspaceSessionContext1786667700000', 'IdentityWorkspaceRls1786667800000', 'ManagerWorkspaceRls1786667900000',
  'WorkspaceBackfill1786668000000', 'OperationalWorkspaceRlsTransition1786668100000', 'ManagerProfileWorkspaceRls1786668150000',
  'ManagerProfileRlsRevertToOrgScoped1786668200000', 'VenueManagerAssignmentRlsFix1786668300000', 'ResolveWorkspaceForUserPreAuthExemption1786668400000',
  'VenueManagerAssignmentRlsShadowFix1786668500000', 'StaffProfileVenueManagerVisibility1786668600000', 'PlatformAdminOperationalRlsVisibility1786668700000',
  'JobRoleVenueManagerAndAdminVisibility1786668800000', 'UserSelectRlsRevertToOrgScoped1786668900000', 'ManagerWorkspaceSelectOwnerVisibility1786669000000',
  'PasswordResetTokenRlsFix1786669100000', 'RefreshTokenAdminRevocationRlsFix1786669200000', 'SelectPreconditionForWritesRlsFix1786669300000',
  'PlatformAdminGlobalRedesign1786669400000', 'CompositeWorkspaceForeignKeys1786669500000', 'IsActivePlatformAdminSearchPathFix1786669600000',
  'RevokePublicOnSecurityDefinerFunctions1786669700000', 'RevokeUserPasswordHashSelectFromApp1786669800000', 'DropUnusedPlatformMaintenance1786669900000',
  'UserEmailOrgUniqueConstraint1786670000000', 'AccountInviteSchema1786670100000', 'EmailOutboxSchema1786670200000',
  'UserOwnsManagerWorkspaceCheck1786670300000', 'EmailOutboxNotificationJobType1786670400000', 'EmergencyContactAndUserNoteSchema1786670500000',
  'StaffProfileJobRoleFk1786670600000', 'UserTemporaryPasswordHash1786670700000', 'StaffProfileExtendedFields1786670800000',
  'StaffProfileLanguages1786670900000', 'WorkspaceForeignKeysValidate1786671000000', 'AuditLogActorCreatedAtIndex1786671100000',
  'VenueDefaultBreakMinutes1786671200000', 'ShiftRequestApprovalSchema1786671300000', 'VenueManagerWorkspaceBackfill1786671400000',
  'ShiftRequestStaffSelection1786671500000', 'VenueManagerStaffTeam1786671600000', 'AuthenticationApplicationTarget1786671700000',
  'VenueRequestDefaultPermissions1786671800000', 'AttendanceStatusWiden1786671900000', 'AttendanceGeofenceColumns1786672000000',
  'AttendanceQrColumns1786672100000', 'ReportSchema1786672200000', 'AttendanceCorrectionSchema1786672300000',
  'EmailOutboxAttachmentColumns1786672400000', 'VenueManagerAttendanceReviewPermissions1786672500000', 'StoredFileMetadata1786672600000',
  'AttendancePostShiftLifecycle1786672700000', 'DashboardListIndexes1786672800000', 'RefreshTokenAbsoluteSessionExpiry1786672900000',
  'NotificationPreferenceTypeWiden1786673000000', 'ReplacementRequestSchema1786673100000', 'WorkerEventSchema1786673200000',
  'ReplacementRequestApprovingState1786673300000', 'ShiftCancellationColumns1786673400000', 'ManagerConfirmationTimeoutIndex1786673500000',
  'PostShiftTimingCorrection1786673600000', 'OriginalTimesheetFile1786673700000', 'ShiftReportReplacementRequestWorkspaceFks1786673800000',
  'EmailOutboxDeliveryFencing1786673900000', 'RequestAssignmentTimes1786674200000', 'AssignmentBreakAndDefaults1786674300000',
  'JobRoleWorkspaceScopedUniqueness1786674400000', 'StaffReferenceWorkspaceScopedUniqueness1786674500000', 'WorkspaceSchemaProvisioning1786674600000',
  'WorkspaceMembership1786674700000', 'TenantWritePolicies1786674800000', 'WorkspaceSchemaRegistry1786674900000',
  'WorkspaceMembershipCutover1786675000000', 'WorkspaceMembershipBackfill1786675100000', 'WorkspaceMembershipForceRls1786675200000',
  'PreAuthEmailCitextLookup1786675300000', 'RetireResolveWorkspaceForUser1786675400000', 'VenueManagerCreatePermission1786675500000',
  'AdminWorkspaceInOrgLookup1786675600000', 'StoredFileWorkspacePolicy1786675700000', 'StaffProfileForceRls1786675800000',
  'ManagerProfileForceRls1786675810000', 'StaffProfileWorkspaceRequired1786676000000', 'VenueManagerStaffCompositeParentKeys1786676100000',
  'VenueManagerStaffCompositeFksNotValid1786676200000', 'VenueManagerStaffCompositeFksValidate1786676300000', 'StaffVenueRlsRoleAware1786676400000',
  'WorkerRuntimeFunctions1786676500000', 'StaffProfileWorkerScanPolicy1786676600000', 'WorkerOrganisationDiscovery1786676700000',
  'WorkerDueWork1786676800000', 'WorkspaceSchemaLifecycleGate1786677000000', 'ManagerVenueWorkspaceBinding1786677200000',
  'ManagerVenueWorkspaceNotNull1786677300000', 'ManagerProfileWorkspaceVisibility1786677400000', 'ManagerProfileOwnWorkspaceWrite1786677500000',
  'ManagerProfileWorkspaceBindingGuard1786677600000', 'HwsBackfillCheckpoint1786677700000', 'WorkspaceLifecycleGrantTightening1786677800000',
  'RefreshReuseRetentionExtension1786677900000', 'UserSession1786678000000', 'UserSessionColumnPrivilegeTightening1786679000000',
  'WebSessionCredentialAndAuthProvider1786680000000', 'OrganisationAuthProviders1786680100000', 'UserAuthIdentity1786680200000',
  'OAuthTransactionState1786680300000', 'WebSessionCookieAuthentication1786681000000', 'CrewflowSingleCredentialRoleArchitecture1786682000000',
  'SecurityVersionVectors1786683000000', 'SecurityVersionMonotonicGuard1786684000000', 'UserSessionIdleExpiryPrivilege1786685000000',
  'AuditLogCrewflowOwnerRevoke1786686000000', 'CrewflowAppRestrictedRuntimeRole1786687000000', 'WorkspaceSchemaCrewflowAppUsageGrant1786688000000',
  'AuthFindSessionAbsoluteExpiry1786691000000', 'AuditLogImmutableHistoricalIdentifiers1786692000000', 'WorkerPendingWorkspaceSchemaDiscovery1786693000000',
  'WorkspaceProvisionerLifecycleGrants1786694000000', 'WorkerResolveWorkspaceOrganisation1786695000000', 'WorkspaceTemplateReferencesGrants1786696000000',
  'OrganisationUpdatedAt1786697000000', 'RealtimeEventOutbox1786698000000', 'CrewflowAppUserSessionIdleExpiryGrant1786699000000',
  'PushDeliverySchema1786700000000', 'NotificationPreferenceTypeWidenClockInWindow1786701000000', 'OrganisationSuspension1786702000000',
  'AuthFindPasswordHashByUserId1786703000000', 'AuditUserIdsExist1786704000000', 'OrganisationIsSuspended1786705000000',
  'CreateOrganisationFunction1786706000000', 'ListOrganisationsForAdmin1786707000000', 'ManagerProfilePlatformAdminRls1786708000000',
  'SecureOwnerManagerProfileSelectGrant1786709000000', 'SecureOwnerRolePermissionSelectGrant1786710000000', 'ManagerProfilePlatformAdminRlsFix1786711000000',
  'ManagerWorkspacePlatformAdminRls1786712000000', 'InitialManagerOnboardingSlot1786713000000', 'WorkspaceSchemaSupersededStatus1786714000000',
  'WorkspaceMemberRoles1786714500000', 'MemberInvitationSchema1786715000000', 'RoleObjectFieldPermissions1786716000000',
  'OAuthBrowserBindingAndHandoff1786717000000', 'WebSessionRetention1786717100000', 'BackfillCustomRoleObjectRules1786717200000',
  'OrganisationIsolationHardening1786717300000', 'EmailUniqueAcrossOrganisationsForNewAccounts1786717400000', 'EmailUniqueTriggerPreservesStoredEmail1786717500000',
  'BackfillCustomRoleObjectRulesUnderForcedRls1786717600000', 'ReconcileCoreOwnershipAndRuntimeGrants1786717700000', 'EmailChangeRequest1786717800000',
  'DatabaseDefenceInDepth1786717900000', 'PermissionCatalogueAndSystemRoleDefaults1786718000000', 'ShiftTeamReadScope1786718100000',
  'VenueManagerStaffAssignment1786718200000', 'ShiftReviewSignoff1786718300000', 'ShiftReviewWorkerScan1786718400000',
  'AttendanceReview1786718500000', 'NavigationLayout1786718600000', 'VenuePhoto1786718700000',
  'PayrollRecord1786718800000', 'ManagerPayrollApproveDefault1786718900000', 'PayStatement1786719000000',
  'ApprovedShiftStatement1786719100000', 'PayrollCalendarRunsPayslips1786719200000', 'ManagerMarkPaidInitialManagerCalendar1786719300000',
  'OfferKind1786719400000', 'AttendanceCheckIn1786719450000', 'ServerPathWorkspaceProvisioning1786719500000',
  'WorkspaceBoundChecksForLaterTables1786719510000', 'HwsHistoricalRowsPrivilegedCopy1786719520000', 'ReconcileSuperuserOwnedCoreObjects1786719600000',
  'AuditLogRecordedIdentityOrganisationCheck1786719610000', 'BootstrapFirstPlatformAdminFunction1786719620000', 'PayrollEvidenceRestrict1786719700000',
  'EmailOutboxSecretBodyScrub1786719710000', 'WorkspaceSchemaMigrationLedger1786719800000', 'AttendanceMoneyChecks1786719810000',
  'HostLabelNamespace1786719820000', 'HostLabelResolverDisplayName1786719830000', 'MfaTotpRecoveryCodes1786719900000',
  'LoginHandoff1786719910000', 'ArchiveAndSearchSchema1786719920000', 'OutboxRetentionReplay1786719940000',
  'AuditLogTimelineIndex1786719950000', 'EncryptedColumnEnvelopeChecks1786719960000', 'FieldPermissionObjects1786719970000',
  'MfaHandoffFollowups1786719980000', 'FieldPermissionPayrollRecordKey1786719990000', 'SettingsViewLeadershipDefault1786720000000',
  'OrganisationCeoInvitation1786720010000', 'CrewflowAppCopiedWriteGrantRevoke1786720020000', 'OAuthReauthenticateIntent1786720030000',
  'AdminPanelReadFunctions1786720100000', 'AuditLogOrganisationActionIndex1786720110000', 'AiUsePermissionDefault1786720210000',
  'AiPhase1Schema1786720220000', 'AiDevRealProvider1786720230000', 'AiSettingsPermission1786720240000',
  'AiModelPreference1786720250000', 'AiAssistantProfile1786720900000', 'AiWorkspaceInstructions1786720910000',
  'AiModelLevelPolicy1786720920000', 'AiTurnLevelReasoning1786720930000', 'AiUsageCacheAccounting1786720940000',
  'AiUsageLedger1786720950000', 'AiActionProposalActivate1786720960000', 'AiQueuedTurnCheckpoint1786720970000',
  'AiUsageTitleCalls1786720980000', 'AiAssistantRoundOnly1786720990000', 'AiSkillSchema1786721000000',
  'AiMessageSkillTags1786721010000', 'AiTurnContinuation1786721020000', 'AiAgentsPermission1786721030000',
  'RoleAssignableToAgents1786721040000', 'AiAgentSchema1786721050000', 'AiAgentDueWork1786721060000',
  'AiInputRequest1786721070000', 'AiUsageWaitingOutcome1786721080000', 'VenueTeamOrgAdmin1786721090000',
  'SecureOwnerCoreSchemaAndHelpers1786721100000', 'NavigationLayoutCrewflowOwner1786721110000', 'ProvisionWorkspaceGuards1786721210000',
  'ProvisioningHealth1786721220000', 'DeploymentIdentity1786721230000', 'WorkerDispatchPointer1786721300000',
  'WorkerDispatchPointerOutboxTriggers1786721310000', 'StatementDispatchPointer1786721320000', 'AccountInviteCleanupDefiner1786721340000',
  'StatementPointerPhysicalIdentity1786721350000', 'PreAuthTablesForceOwnerOnly1786721400000', 'WorkspaceRegistryGuardAllowList1786721410000',
  'OwnerLoginGrantParityGuards1786721420000', 'WorkspaceGrantParityGuards1786721430000',
]);

const R256_NAMES: readonly string[] = Object.freeze([...R254_NAMES, 'OutboxClaimIndexes1786721440000', 'RefreshTokenReplacedByIndex1786721450000']);

/** Oldest first. Frozen: append only. */
export const RELEASE_MANIFESTS: readonly ReleaseManifest[] = Object.freeze([
  {
    id: 'R254',
    refs: ['rab/v0.4.0 (e1b1132a)', 'cd7c7e32 (adolphus:cd7c7e32, sha256:075b536c…)', '4c38aa1a'],
    count: 254,
    last: 'WorkspaceGrantParityGuards1786721430000',
    sha256: '9571219e4b4737def2d981c80f914cd234d91a53a8197a85673a9ec0839bbfbb',
    names: R254_NAMES,
  },
  {
    id: 'R256',
    refs: ['0e0a6edd (Phase D, sha256:d7750043…)', 'main 3df7855c'],
    count: 256,
    last: 'RefreshTokenReplacedByIndex1786721450000',
    sha256: '618763455d31661a563c5910587ce298e22f1c947522a9c1a9033378ec3243d9',
    names: R256_NAMES,
  },
]);

/**
 * Owner decision P1-2 (2026-11-11): upgrades are supported from R254 and later. The first entry is the floor (moved only by
 * owner decision); every newer manifest MUST also be listed here (release-floor.spec.ts enforces it).
 */
export const SUPPORTED_UPGRADE_FROM: readonly string[] = Object.freeze(['R254', 'R256']);

/**
 * Pure: the problems with a supported list (empty = consistent). Its first entry is the floor; every manifest from the
 * floor on must be listed, in manifest order, and nothing else. Used by the spec so a newer manifest added without its
 * supported entry fails CI instead of refusing that release's databases in production.
 */
export function supportedListProblems(manifests: readonly ReleaseManifest[], supported: readonly string[]): string[] {
  const floor = manifests.findIndex((m) => m.id === supported[0]);
  if (floor < 0) return [`the floor ${supported[0] ?? '<none>'} is not a recorded release`];
  const want = manifests.slice(floor).map((m) => m.id);
  const missing = want.filter((id) => !supported.includes(id));
  const extra = supported.filter((id) => !want.includes(id));
  const problems = [...missing.map((id) => `${id} is newer than the floor but not supported`), ...extra.map((id) => `${id} is not a release at or after the floor`)];
  if (!problems.length && want.join(',') !== supported.join(',')) problems.push('not in manifest order');
  return problems;
}

/** Targets the floor does not restrict: the same set N1 never restricted. Anything else (an unknown target too) is checked. */
const UNRESTRICTED_TARGETS: ReadonlySet<DbTarget> = new Set<DbTarget>(['local', 'test']);

export const OWNER_LOGIN_RECOVERY_DOC = 'packages/rab-docker/docs/release/OWNER-LOGIN-RECOVERY.md';

/** The floor refused this database. Mapped to outcome `behind` (exit 65); nothing was applied. */
export class UnsupportedUpgradeStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedUpgradeStartError';
  }
}

export function manifestDigest(names: readonly string[]): string {
  return createHash('sha256').update(names.join('\n')).digest('hex');
}

/** Pure: a manifest whose names do not match its recorded count, last name and hash. Empty = intact. */
export function manifestProblems(manifest: ReleaseManifest): string[] {
  const problems: string[] = [];
  if (manifest.names.length !== manifest.count) problems.push(`${manifest.id}: ${manifest.names.length} names, recorded ${manifest.count}`);
  if (manifest.names[manifest.names.length - 1] !== manifest.last) problems.push(`${manifest.id}: last name is not ${manifest.last}`);
  if (new Set(manifest.names).size !== manifest.names.length) problems.push(`${manifest.id}: duplicate names`);
  if (manifestDigest(manifest.names) !== manifest.sha256) problems.push(`${manifest.id}: sha256 differs from the recorded value`);
  return problems;
}

export type LedgerAttribution =
  /** The ledger holds every name of `release`; `beyond` (in code order) is the contiguous run of this code's chain after it. */
  | { kind: 'release'; release: string; beyond: string[]; remaining: number }
  /** Every ledger name belongs to the oldest manifest, which it does not complete: a history older than every release. */
  | { kind: 'older'; detail: string }
  /** Anything else: holes, names this code does not know, or a history that is no known release's. */
  | { kind: 'unknown'; detail: string };

/** The 13-digit timestamp suffix of a migration class name (TypeORM's run order), or +Infinity when it has none. */
const timestampOf = (name: string): number => {
  const m = /(\d{13})$/.exec(name);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

/**
 * Pure. Attributes a ledger (`applied`, any order) to the NEWEST manifest it contains, given this code's chain (`code`, any
 * order: it is put into TypeORM's run order, by timestamp, here; the DataSource's glob order is not that order). Beyond that manifest the ledger may hold only a contiguous run of the code's remaining migrations, in code
 * order, starting at the first one: TypeORM applies pending migrations in that order and stops at the first failure, so a
 * resumed or a complete upgrade looks exactly like that; a hole or a name the code does not know never does.
 */
export function attributeLedger(
  applied: readonly string[],
  code: readonly string[],
  manifests: readonly ReleaseManifest[] = RELEASE_MANIFESTS,
): LedgerAttribution {
  const appliedSet = new Set(applied);
  const codeSet = new Set(code);
  const runOrder = [...code].sort((a, b) => timestampOf(a) - timestampOf(b));
  for (const manifest of [...manifests].reverse()) {
    if (!manifest.names.every((name) => appliedSet.has(name))) continue;
    const inRelease = new Set(manifest.names);
    const unknown = applied.filter((name) => !inRelease.has(name) && !codeSet.has(name));
    if (unknown.length) {
      return { kind: 'unknown', detail: `${unknown.length} ledger name(s) after ${manifest.id} unknown to this code: ${unknown.slice(0, 5).join(', ')}` };
    }
    const after = runOrder.filter((name) => !inRelease.has(name));
    const beyond = after.filter((name) => appliedSet.has(name));
    const prefix = after.slice(0, beyond.length);
    if (beyond.some((name, i) => name !== prefix[i])) {
      const missing = prefix.filter((name) => !appliedSet.has(name));
      return { kind: 'unknown', detail: `the ledger is past ${manifest.id} but not contiguously: ${missing.slice(0, 5).join(', ')} missing before later applied migrations` };
    }
    return { kind: 'release', release: manifest.id, beyond, remaining: after.length - beyond.length };
  }
  const oldest = manifests[0];
  if (oldest && applied.every((name) => oldest.names.includes(name))) {
    return { kind: 'older', detail: `${applied.length} of the ${oldest.count} migrations of ${oldest.id} applied` };
  }
  const foreign = oldest ? applied.filter((name) => !oldest.names.includes(name)) : [...applied];
  return { kind: 'unknown', detail: `the ledger contains no known release; ${foreign.length} name(s) outside ${oldest?.id ?? 'every release'}: ${foreign.slice(0, 5).join(', ')}` };
}

export interface UpgradeStartInput {
  /** The guarded target of this run (undefined = could not be established: checked, fail closed). */
  target: DbTarget | undefined;
  /** The classifier's state, on the locked session. */
  state: DatabaseInstallState;
  /** The fresh-install proof (install-state.ts decideFreshInstall). */
  fresh: boolean;
  /** core.migrations names, read on the locked session. */
  applied: readonly string[];
  /** This code's chain (the loaded migrations; put into run order by attributeLedger). */
  code: readonly string[];
  manifests?: readonly ReleaseManifest[];
  supported?: readonly string[];
}

export interface UpgradeStartDecision {
  allowed: true;
  reason: string;
  release: string | null;
}

/** Pure. Returns the allow decision (with a log line) or throws UnsupportedUpgradeStartError. */
export function assertSupportedUpgradeStart(input: UpgradeStartInput): UpgradeStartDecision {
  const manifests = input.manifests ?? RELEASE_MANIFESTS;
  const supported = input.supported ?? SUPPORTED_UPGRADE_FROM;
  if (input.target !== undefined && UNRESTRICTED_TARGETS.has(input.target)) {
    return { allowed: true, reason: `target ${input.target}: the upgrade floor applies to production targets only`, release: null };
  }
  if (input.fresh) return { allowed: true, reason: 'proven fresh install: the full chain is allowed', release: null };
  if (input.state === 'CURRENT') return { allowed: true, reason: 'CURRENT: nothing pending', release: null };
  if (input.state === 'AHEAD') return { allowed: true, reason: 'AHEAD (image rollback): nothing pending, nothing applied', release: null };
  const target = input.target ?? '<unknown>';
  const refuse = (why: string) =>
    new UnsupportedUpgradeStartError(
      `Refusing to upgrade this ${input.state} database (DB_TARGET=${target}): ${why}. Upgrades are supported only from ` +
        `${supported.join(', ')} or later. Nothing was applied; the ledger and the data are unchanged. Upgrade it with a ` +
        `release of the supported floor first or, for a separated-layout database, follow ${OWNER_LOGIN_RECOVERY_DOC}.`,
    );
  if (input.state !== 'CHAIN-PARTIAL') throw refuse(`a ${input.state} database that is not a proven fresh install`);
  const broken = manifests.flatMap(manifestProblems);
  if (broken.length) throw refuse(`the release manifest is not intact (${broken.join('; ')}): fail closed`);
  const attribution = attributeLedger(input.applied, input.code, manifests);
  if (attribution.kind === 'older') throw refuse(`its migration history is older than every supported release (${attribution.detail})`);
  if (attribution.kind === 'unknown') throw refuse(`its migration history is not a supported release (${attribution.detail})`);
  if (!supported.includes(attribution.release)) throw refuse(`its migration history is ${attribution.release}, which is not a supported upgrade start`);
  return {
    allowed: true,
    release: attribution.release,
    reason:
      `upgrade floor passed: the ledger contains ${attribution.release}` +
      (attribution.beyond.length ? ` plus ${attribution.beyond.length} later migration(s) (resuming a partial upgrade)` : '') +
      `; ${attribution.remaining} migration(s) to apply`,
  };
}
