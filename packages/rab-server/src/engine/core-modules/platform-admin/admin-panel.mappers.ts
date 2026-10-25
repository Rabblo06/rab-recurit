/**
 * Crewflow Platform Admin Panel — explicit allowlist mappers. Every Admin Panel response is built here, field by field,
 * from the fixed column sets the admin_* SQL functions return. Nothing is spread through (`...row`), so a column added to
 * a function later can never reach a client by accident. No password/secret/hash/token/payload/body/amount key exists in
 * any type below (asserted by `admin-panel.mappers.spec.ts` and the integration response snapshots).
 */

export interface RawUserSearchRow {
  userId: string;
  organisationId: string;
  organisationName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  status: string;
  createdAt: Date | string;
  lastLoginAt: Date | string | null;
  totpEnabled: boolean;
  mfaEnabledAt: Date | string | null;
  recoveryCodesRemaining: number | null;
  recoveryCodesTotal: number | null;
  isPlatformAdmin: boolean;
  roleKeys: string[] | null;
  roleNames: string[] | null;
  matchKind: string;
}

export interface AdminUserListItem {
  id: string;
  organisationId: string;
  organisationName: string | null;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  isPlatformAdmin: boolean;
  /** System role keys (ceo, org_admin, manager, venue_manager, staff) — drives the role filter and labels. */
  roleKeys: string[];
  /** Display names of the user's organisation-level roles (≤10). */
  roles: string[];
  twoFactor: { enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number | null; recoveryCodesTotal: number | null };
}

export interface AdminUserSummary extends AdminUserListItem {
  sessions: { total: number; managerWeb: number; venueManagerApp: number; staffApp: number };
  lastSignInProvider: 'password' | 'google' | 'microsoft' | null;
  failedSignIns24h: number;
}

const iso = (v: Date | string | null | undefined): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
export const SYSTEM_ROLE_KEYS = new Set(['ceo', 'org_admin', 'manager', 'venue_manager', 'staff']);
const USER_STATUSES = new Set(['active', 'invited', 'suspended', 'deactivated', 'invite_expired']);

export function toUserListItem(r: RawUserSearchRow): AdminUserListItem {
  const enabled = r.totpEnabled === true;
  return {
    id: str(r.userId),
    organisationId: str(r.organisationId),
    organisationName: r.organisationName === null || r.organisationName === undefined ? null : String(r.organisationName),
    firstName: str(r.firstName),
    lastName: str(r.lastName),
    email: str(r.email),
    status: USER_STATUSES.has(str(r.status)) ? str(r.status) : 'unknown',
    createdAt: iso(r.createdAt)!,
    lastLoginAt: iso(r.lastLoginAt),
    isPlatformAdmin: r.isPlatformAdmin === true,
    roleKeys: (Array.isArray(r.roleKeys) ? r.roleKeys : []).map(String).filter((k) => SYSTEM_ROLE_KEYS.has(k)),
    roles: (Array.isArray(r.roleNames) ? r.roleNames : []).map((n) => String(n).slice(0, 80)).slice(0, 10),
    twoFactor: {
      enabled,
      enabledAt: enabled ? iso(r.mfaEnabledAt) : null,
      recoveryCodesRemaining: enabled && typeof r.recoveryCodesRemaining === 'number' ? r.recoveryCodesRemaining : null,
      recoveryCodesTotal: enabled && typeof r.recoveryCodesTotal === 'number' ? r.recoveryCodesTotal : null,
    },
  };
}

export interface RawPlatformAdminRow {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  organisationId: string;
  organisationName: string | null;
  totpEnabled: boolean;
  grantedAt: Date | string;
  grantedBy: string | null;
  grantedByFirstName: string | null;
  grantedByLastName: string | null;
}

export interface AdminPlatformAdminItem {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  organisationName: string | null;
  twoFactorEnabled: boolean;
  grantedAt: string;
  /** null = the one-time bootstrap (no granting admin). */
  grantedBy: { userId: string; name: string } | null;
  isYou: boolean;
}

export function toPlatformAdminItem(r: RawPlatformAdminRow, actorUserId: string): AdminPlatformAdminItem {
  return {
    userId: str(r.userId),
    firstName: str(r.firstName),
    lastName: str(r.lastName),
    email: str(r.email),
    organisationName: r.organisationName === null || r.organisationName === undefined ? null : String(r.organisationName),
    twoFactorEnabled: r.totpEnabled === true,
    grantedAt: iso(r.grantedAt)!,
    grantedBy: r.grantedBy ? { userId: str(r.grantedBy), name: `${str(r.grantedByFirstName)} ${str(r.grantedByLastName)}`.trim() } : null,
    isYou: str(r.userId) === actorUserId,
  };
}

export interface RawOrganisationRow {
  id: string;
  name: string;
  slug: string;
  suspendedAt: Date | string | null;
  createdAt: Date | string;
  ceoUserId: string | null;
  ceoEmail: string | null;
  ceoFirstName: string | null;
  ceoLastName: string | null;
  ceoStatus: string | null;
}

export interface AdminOrganisationListItem {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  suspendedAt: string | null;
  createdAt: string;
  ceo: { userId: string; name: string; email: string; status: string; activated: boolean } | null;
}

export interface AdminOrganisationSummary extends AdminOrganisationListItem {
  ceo: (NonNullable<AdminOrganisationListItem['ceo']> & { twoFactorEnabled: boolean | null }) | null;
  members: { active: number };
  workspaces: { total: number; ready: number; creating: number; failed: number };
}

export function toOrganisationListItem(r: RawOrganisationRow): AdminOrganisationListItem {
  return {
    id: str(r.id),
    name: str(r.name),
    slug: str(r.slug),
    suspended: r.suspendedAt !== null && r.suspendedAt !== undefined,
    suspendedAt: iso(r.suspendedAt),
    createdAt: iso(r.createdAt)!,
    ceo: r.ceoUserId
      ? {
          userId: str(r.ceoUserId),
          name: `${str(r.ceoFirstName)} ${str(r.ceoLastName)}`.trim(),
          email: str(r.ceoEmail),
          status: USER_STATUSES.has(str(r.ceoStatus)) ? str(r.ceoStatus) : 'unknown',
          activated: str(r.ceoStatus) === 'active',
        }
      : null,
  };
}

export interface RawWorkspaceRow {
  workspaceId: string;
  organisationId: string;
  organisationName: string | null;
  workspaceName: string | null;
  schemaName: string | null;
  schemaStatus: string | null;
  schemaVersion: number | null;
  schemaError: string | null;
  schemaMigratedAt: Date | string | null;
  updatedAt: Date | string;
  registryStatus: string | null;
  moduleVersion: number | null;
  driftStatus: string | null;
  registryError: string | null;
}

export interface AdminWorkspaceListItem {
  workspaceId: string;
  organisationId: string;
  organisationName: string | null;
  workspaceName: string;
  schemaName: string | null;
  schemaStatus: 'CREATING' | 'READY' | 'MIGRATING' | 'FAILED' | 'SUPERSEDED' | null;
  schemaVersion: number | null;
  moduleVersion: number | null;
  registryStatus: 'PROVISIONING' | 'READY' | 'FAILED' | null;
  driftStatus: string | null;
  error: string | null;
  updatedAt: string;
}

const SCHEMA_STATUSES = new Set(['CREATING', 'READY', 'MIGRATING', 'FAILED', 'SUPERSEDED']);
const REGISTRY_STATUSES = new Set(['PROVISIONING', 'READY', 'FAILED']);
const DRIFT_STATUSES = new Set(['UNCHECKED', 'OK', 'DRIFTED', 'MISSING', 'UNVERIFIED', 'NOT_READY']);
/** Same rule as the SQL function: a fixed label / SQLSTATE passes; anything resembling free text does not. */
export const safeErrorLabel = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : /^[A-Za-z0-9_.:/() -]{1,120}$/.test(String(v)) ? String(v) : 'UNCLASSIFIED';

export function toWorkspaceListItem(r: RawWorkspaceRow): AdminWorkspaceListItem {
  const schemaStatus = r.schemaStatus && SCHEMA_STATUSES.has(r.schemaStatus) ? (r.schemaStatus as AdminWorkspaceListItem['schemaStatus']) : null;
  const registryStatus = r.registryStatus && REGISTRY_STATUSES.has(r.registryStatus) ? (r.registryStatus as AdminWorkspaceListItem['registryStatus']) : null;
  return {
    workspaceId: str(r.workspaceId),
    organisationId: str(r.organisationId),
    organisationName: r.organisationName === null || r.organisationName === undefined ? null : String(r.organisationName),
    workspaceName: str(r.workspaceName),
    schemaName: r.schemaName && /^workspace_[0-9a-f]{32}$/.test(r.schemaName) ? r.schemaName : null,
    schemaStatus,
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : null,
    moduleVersion: typeof r.moduleVersion === 'number' ? r.moduleVersion : null,
    registryStatus,
    driftStatus: r.driftStatus && DRIFT_STATUSES.has(r.driftStatus) ? r.driftStatus : null,
    error: safeErrorLabel(r.schemaError) ?? safeErrorLabel(r.registryError),
    updatedAt: iso(r.updatedAt)!,
  };
}

export interface RawAuditRow {
  id: string;
  organisationId: string;
  organisationName: string | null;
  action: string;
  actorUserId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  targetUserId: string | null;
  targetFirstName: string | null;
  targetLastName: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date | string;
  reason: string | null;
  detail: Record<string, unknown> | null;
}

export interface AdminAuditItem {
  id: string;
  action: string;
  organisationId: string;
  organisationName: string | null;
  createdAt: string;
  actor: { userId: string; name: string } | null;
  target: { userId: string; name: string } | null;
  entity: { type: string; id: string } | null;
  reason: string | null;
  detail: { queue?: string; count?: number; resultCount?: number; revokedSessions?: number; enabled?: boolean; kind?: string; refusal?: string };
}

const name = (first: string | null, last: string | null) => `${str(first)} ${str(last)}`.trim();

export function toAuditItem(r: RawAuditRow, allowedActions: readonly string[]): AdminAuditItem | null {
  if (!allowedActions.includes(r.action)) return null; // defence in depth: the SQL function already refuses others
  const d = r.detail ?? {};
  const detail: AdminAuditItem['detail'] = {};
  if (typeof d.queue === 'string' && /^[a-z0-9:-]{1,64}$/.test(d.queue)) detail.queue = d.queue;
  for (const k of ['count', 'resultCount', 'revokedSessions'] as const) if (typeof d[k] === 'number' && Number.isFinite(d[k])) detail[k] = d[k] as number;
  if (typeof d.enabled === 'boolean') detail.enabled = d.enabled;
  if (typeof d.kind === 'string' && /^[a-z_]{1,32}$/.test(d.kind)) detail.kind = d.kind;
  if (typeof d.refusal === 'string' && /^[a-z_]{1,64}$/.test(d.refusal)) detail.refusal = d.refusal;
  return {
    id: str(r.id),
    action: r.action,
    organisationId: str(r.organisationId),
    organisationName: r.organisationName === null || r.organisationName === undefined ? null : String(r.organisationName),
    createdAt: iso(r.createdAt)!,
    actor: r.actorUserId ? { userId: str(r.actorUserId), name: name(r.actorFirstName, r.actorLastName) } : null,
    target: r.targetUserId ? { userId: str(r.targetUserId), name: name(r.targetFirstName, r.targetLastName) } : null,
    entity: r.entityType && r.entityId ? { type: String(r.entityType).slice(0, 64), id: str(r.entityId) } : null,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : null,
    detail,
  };
}
