import { api } from '../../../shared/api';

/**
 * Crewflow Platform Admin Panel — the ONE place this feature talks to the server. Every type below mirrors a server-side
 * allowlist mapper (`rab-server/src/engine/core-modules/platform-admin/admin-panel.mappers.ts` & co.); nothing here is
 * computed or invented on the client. Where the server has no source yet, the type says so (null / `available: false`).
 */

export type AdminTab = 'general' | 'health' | 'config' | 'security' | 'workspaces' | 'audit';

export interface TwoFactorState {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number | null;
  recoveryCodesTotal: number | null;
}

export interface AdminUser {
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
  roleKeys: string[];
  roles: string[];
  twoFactor: TwoFactorState;
}

export interface AdminUserSummary extends AdminUser {
  sessions: { total: number; managerWeb: number; venueManagerApp: number; staffApp: number };
  lastSignInProvider: 'password' | 'google' | 'microsoft' | null;
  failedSignIns24h: number;
}

export interface AdminPlatformAdmin {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  organisationName: string | null;
  twoFactorEnabled: boolean;
  grantedAt: string;
  grantedBy: { userId: string; name: string } | null;
  isYou: boolean;
}

export interface AdminOrganisation {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  suspendedAt: string | null;
  createdAt: string;
  ceo: { userId: string; name: string; email: string; status: string; activated: boolean } | null;
}

export interface AdminOrganisationSummary extends Omit<AdminOrganisation, 'ceo'> {
  ceo: (NonNullable<AdminOrganisation['ceo']> & { twoFactorEnabled: boolean | null }) | null;
  members: { active: number };
  workspaces: { total: number; ready: number; creating: number; failed: number };
}

export interface AdminOverview {
  organisations: { total: number; active: number; suspended: number };
  users: { total: number; signedInLast7Days: number };
  sessions: { active: number; platformAdminSessionsToday: number };
  platformAdmins: { active: number };
  workspaces: { ready: number; creating: number; failed: number; other: number };
}

export interface AdminGeneral {
  version: string;
  latestVersion: string | null;
  commit: string | null;
}

export interface AdminMigrations {
  applied: number;
  latest: string | null;
  pending: number | null;
}

export type HealthStatus = 'healthy' | 'warning' | 'degraded' | 'unavailable';
export interface HealthCard {
  key: 'database' | 'redis' | 'worker' | 'provisioner' | 'email' | 'storage';
  status: HealthStatus;
  detail: string;
  latencyMs: number | null;
}
export interface HealthReport {
  checkedAt: string;
  cards: HealthCard[];
  attention: number;
}

export type JobState = 'failed' | 'active' | 'waiting' | 'delayed' | 'completed';
export interface QueueSummary {
  name: string;
  kind: 'consumer' | 'scan';
  counts: Partial<Record<JobState | 'paused' | 'prioritized', number>> | null;
  actions: { retry: JobState[]; delete: JobState[]; lockedReason: string | null };
}
export interface WorkerCycle {
  source: 'worker' | 'provisioner';
  loop: string;
  runs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  succeeded: number;
  idle: number;
  failed: number;
  skipped: number;
  measuredAt: string | null;
}
export interface QueuesOverview {
  mode: 'interval' | 'bullmq';
  queues: QueueSummary[];
  metrics: { available: false; reason: string };
  worker: { heartbeatAgeSeconds: number | null; stale: boolean; scheduler: { reconciledAt: string | null; schedulers: number | null } | null };
  cycles: WorkerCycle[];
  lastRuns: Array<{ key: string; at: string }>;
}
export interface JobItem {
  id: string;
  name: string;
  state: JobState;
  createdAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  attemptsMade: number;
  maxAttempts: number | null;
  errorClass: string | null;
  organisationId: string | null;
  entityId: string | null;
  scheduler: boolean;
}
export interface JobActionResult {
  queue: string;
  done: string[];
  skipped: Array<{ id: string; reason: 'not_found' | 'wrong_state' | 'scheduler' }>;
}

export interface FailedOutboxItem {
  kind: 'email' | 'push' | 'realtime' | 'worker_event';
  id: string;
  organisationId: string;
  workspaceId: string | null;
  type: string | null;
  attempts: number;
  lastErrorCode: string | null;
  failedAt: string | null;
  createdAt: string;
  replayable?: boolean;
}

export interface AdminConfig {
  maintenanceMode: { enabled: boolean; message: string | null };
}
export interface EmailSettings {
  driver: string;
  fromAddress: string | null;
  replyToSet: boolean;
  deliveryEnabled: boolean;
  credential: 'set' | 'not_set' | 'not_needed';
}
export interface EnvironmentRow {
  group: string;
  key: string;
  state: 'set' | 'not_set' | 'value';
  value: string | null;
  source: string;
}
export interface SecuritySwitch {
  label: string;
  variable: string;
  state: string;
  recommended: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
}
export interface SigningKey {
  kid: string;
  use: 'signs_and_verifies' | 'verifies_only';
  derivedFrom: string;
  status: 'active' | 'accepted';
  verified24h: null;
}
export interface SecurityReport {
  switches: SecuritySwitch[];
  signingKeys: SigningKey[];
  encryptionKeys: { activeKid: string; kids: string[] };
}

export interface WorkspaceRow {
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

export interface AuditItem {
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

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The step-up proof the shared dialog collects. Sent inline only where the server contract takes it inline. */
export interface StepUpProof {
  currentPassword?: string;
  code?: string;
}

export const adminApi = {
  general: async () => (await api.get<AdminGeneral>('/admin/general')).data,
  overview: async () => (await api.get<AdminOverview>('/admin/overview')).data,
  migrations: async () => (await api.get<AdminMigrations>('/admin/migrations')).data,
  searchUsers: async (q: string, role?: string, limit?: number) =>
    (await api.get<AdminUser[]>('/admin/users/search', { params: { ...(q ? { q } : {}), ...(role ? { role } : {}), ...(limit ? { limit } : {}) } })).data,
  userSummary: async (userId: string) => (await api.get<AdminUserSummary>(`/admin/users/${encodeURIComponent(userId)}/summary`)).data,
  platformAdmins: async () => (await api.get<AdminPlatformAdmin[]>('/admin/platform-admins')).data,
  searchOrganisations: async (q: string) => (await api.get<AdminOrganisation[]>('/admin/lookup/organisations', { params: q ? { q } : undefined })).data,
  organisationSummary: async (id: string) => (await api.get<AdminOrganisationSummary>(`/admin/lookup/organisations/${encodeURIComponent(id)}/summary`)).data,
  health: async () => (await api.get<HealthReport>('/admin/health/report')).data,
  queues: async () => (await api.get<QueuesOverview>('/admin/queues')).data,
  jobs: async (queue: string, state: JobState) => (await api.get<{ items: JobItem[]; total: number | null }>(`/admin/queues/${encodeURIComponent(queue)}/jobs`, { params: { state, limit: 25 } })).data,
  failedOutbox: async () => (await api.get<FailedOutboxItem[]>('/admin/outbox/failed', { params: { limit: 50 } })).data,
  config: async () => (await api.get<AdminConfig>('/admin/config')).data,
  email: async () => (await api.get<EmailSettings>('/admin/config/email')).data,
  environment: async () => (await api.get<EnvironmentRow[]>('/admin/config/environment')).data,
  security: async () => (await api.get<SecurityReport>('/admin/security')).data,
  workspaces: async (cursor?: string) => (await api.get<Page<WorkspaceRow>>('/admin/workspaces', { params: cursor ? { cursor } : undefined })).data,
  audit: async (params: { action?: string; user?: string; cursor?: string }) =>
    (await api.get<Page<AuditItem>>('/admin/audit', { params: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) })).data,

  // ---- mutations -------------------------------------------------------------------------------------------------
  /**
   * The "Confirm it's you" proof for routes that take NO inline password (they call `assertRecentStepUp` server-side):
   * the dialog's password/code go to `POST /auth/step-up` first, then the action is sent with its reason only. If the
   * admin left the password empty, the action goes straight out and the shared StepUpHost answers STEP_UP_REQUIRED.
   */
  stepUpIfGiven: async (proof: StepUpProof) => {
    if (!proof.currentPassword) return;
    await api.post('/auth/step-up', proof.code ? { currentPassword: proof.currentPassword, code: proof.code } : { currentPassword: proof.currentPassword });
  },
  revokeSessions: async (userId: string, reason: string) =>
    (await api.post<{ revokedSessions: number; revokedRefreshTokens: number }>(`/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, { reason })).data,
  retryJobs: async (queue: string, jobIds: string[], reason: string) => (await api.post<JobActionResult>(`/admin/queues/${encodeURIComponent(queue)}/jobs/retry`, { jobIds, reason })).data,
  deleteJobs: async (queue: string, jobIds: string[], reason: string) => (await api.post<JobActionResult>(`/admin/queues/${encodeURIComponent(queue)}/jobs/delete`, { jobIds, reason })).data,
  /** Recent step-up required server-side; the reason is audited in the replay's own transaction. */
  replayEmail: async (organisationId: string, emailId: string, reason: string) =>
    (await api.post<{ result: 'REPLAYED' }>(`/admin/outbox/organisations/${encodeURIComponent(organisationId)}/emails/${encodeURIComponent(emailId)}/replay`, { reason })).data,
  sendTestEmail: async () => (await api.post<{ sent: boolean; to: string; driver: string }>('/admin/config/email/test', {})).data,
  setMaintenance: async (enabled: boolean, reason: string) => (await api.patch<AdminConfig>('/admin/config/maintenance-mode', { enabled, reason })).data,
  /** Current DTO is `{ currentPassword }` only (no reason, no code): B3 hardening is pending in a lane-owned service. */
  grantPlatformAdmin: async (userId: string, currentPassword: string) => (await api.post<{ granted: boolean }>(`/admin/platform-admins/${encodeURIComponent(userId)}`, { currentPassword })).data,
  revokePlatformAdmin: async (userId: string, currentPassword: string) => (await api.delete<{ revoked: boolean }>(`/admin/platform-admins/${encodeURIComponent(userId)}`, { data: { currentPassword } })).data,
  suspendOrganisation: async (id: string, body: { reason: string; confirmSlug: string; currentPassword: string }) => (await api.post(`/admin/organisations/${encodeURIComponent(id)}/suspend`, body)).data,
  reactivateOrganisation: async (id: string, body: { reason: string; currentPassword: string }) => (await api.post(`/admin/organisations/${encodeURIComponent(id)}/reactivate`, body)).data,
  resendCeoInvite: async (id: string, reason: string) => (await api.post(`/admin/organisations/${encodeURIComponent(id)}/ceo-invite/resend`, { reason })).data,
  ceoInviteState: async (id: string) =>
    (await api.get<{ ceo: { invitationStatus: string; pendingInvite: { sendNumber: number } | null } | null }>(`/admin/organisations/${encodeURIComponent(id)}`)).data,
};

/**
 * Admin "Reset 2FA" — ONE small adapter for the account-security step-1 contract (2026-10-24):
 *   POST /admin/users/:userId/mfa/reset  { reason (3–500), currentPassword?, code? }  →  { reset: true, revokedSessions }
 * Proof inline (password + own code only if enrolled) when the dialog collected a password; otherwise `{ reason }` alone
 * and the shared StepUpHost handles 403 STEP_UP_REQUIRED. Never double-prompts.
 */
export async function resetTwoFactor(userId: string, input: { reason: string } & StepUpProof): Promise<{ reset: true; revokedSessions: number }> {
  const body: Record<string, string> = { reason: input.reason };
  if (input.currentPassword) {
    body.currentPassword = input.currentPassword;
    if (input.code) body.code = input.code;
  }
  return (await api.post<{ reset: true; revokedSessions: number }>(`/admin/users/${encodeURIComponent(userId)}/mfa/reset`, body)).data;
}

/** User-facing text for the reset contract's error codes (the shared normaliser covers everything else). */
export const RESET_2FA_ERROR_TEXT: Record<string, string> = {
  MFA_RESET_SELF: 'You can’t reset your own two-factor authentication here. Use Settings → Account.',
  STEP_UP_MFA_INVALID: 'That code didn’t work. Enter the current code from your own authenticator app.',
  MFA_NOT_ENABLED: 'This user hasn’t turned on two-factor authentication, so there is nothing to reset.',
  MFA_RESET_REQUIRES_SECOND_ADMIN: 'Resetting another platform admin needs a second administrator; this isn’t available yet.',
  MFA_RESET_RATE_LIMITED: 'You’ve reached the limit of 5 resets an hour. Try again later.',
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'platform_admin.granted': 'Platform admin added',
  'platform_admin.revoked': 'Platform admin removed',
  'platform_admin.bootstrapped': 'First platform admin created',
  'organisation.suspended': 'Organisation suspended',
  'organisation.reactivated': 'Organisation reactivated',
  'organisation_invitation.sent': 'CEO invitation sent',
  'organisation_invitation.resent': 'CEO invitation resent',
  'organisation_invitation.revoked': 'CEO invitation revoked',
  'user.invite_resent': 'CEO invite resent',
  'admin.inspect_started': 'Inspect started',
  'admin.inspect_ended': 'Inspect ended',
  'admin.inspect_mutation_refused': 'Inspect change refused',
  'user.mfa_reset_by_admin': '2FA reset',
  'user.mfa_reset_refused': '2FA reset refused',
  'platform_config.smtp_updated': 'SMTP settings changed',
  'platform_config.maintenance_mode_changed': 'Maintenance mode changed',
  'email.replay_requested': 'Email replayed',
  'admin.sessions_revoked': 'Signed out everywhere',
  'admin.queue_jobs_retried': 'Job retried',
  'admin.queue_jobs_deleted': 'Job deleted',
  'admin.user_searched': 'User searched',
  'admin.user_viewed': 'User viewed',
  'admin.organisation_searched': 'Organisation searched',
  'admin.test_email_sent': 'Test email sent',
  'admin.email_replay_reason': 'Email replay reason',
};

export const ROLE_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All roles' },
  { value: 'ceo', label: 'CEO' },
  { value: 'org_admin', label: 'Org admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'venue_manager', label: 'Venue manager' },
  { value: 'staff', label: 'Staff' },
  { value: 'platform_admin', label: 'Platform admin' },
];

const ROLE_LABEL: Record<string, string> = { ceo: 'CEO', org_admin: 'Org admin', manager: 'Manager', venue_manager: 'Venue manager', staff: 'Staff' };
export function roleLabel(user: Pick<AdminUser, 'roleKeys' | 'roles'>): string {
  const keys = user.roleKeys.map((k) => ROLE_LABEL[k]).filter(Boolean);
  if (keys.length) return keys.join(', ');
  return user.roles.length ? user.roles.join(', ') : '—';
}

export const fullName = (u: { firstName: string; lastName: string; email?: string }) => `${u.firstName} ${u.lastName}`.trim() || u.email || '—';
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
