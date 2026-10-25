import type { QueryClient } from '@tanstack/react-query';

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
  /** Every Worker records BullMQ metrics (one-minute points, one week kept). The chart reads `/queues/:queue/metrics`. */
  metrics: { collected: boolean; retentionMinutes: number };
  worker: { heartbeatAgeSeconds: number | null; stale: boolean; scheduler: { reconciledAt: string | null; schedulers: number | null } | null };
  cycles: WorkerCycle[];
  lastRuns: Array<{ key: string; at: string }>;
}
export type MetricsRange = '1H' | '4H' | '12H' | '1D' | '7D';
export const METRICS_RANGES: MetricsRange[] = ['1H', '4H', '12H', '1D', '7D'];
export interface QueueMetrics {
  queue: string;
  range: MetricsRange;
  /** 1 for 1H, 60 for every other range. */
  bucketMinutes: 1 | 60;
  from: string;
  to: string;
  /** false = "Metrics unavailable" (nothing recorded yet, or Redis did not answer). Never filled in from counts. */
  available: boolean;
  reason: 'NO_DATA' | 'UNAVAILABLE' | null;
  buckets: Array<{ at: string; completed: number; failed: number }>;
  totals: { completed: number; failed: number };
  generatedAt: string;
}

const METRICS_RANGE_TEXT: Record<MetricsRange, string> = { '1H': 'last hour', '4H': 'last 4 h', '12H': 'last 12 h', '1D': 'last 24 h', '7D': 'last 7 days' };

/** "last 24 h · 3,958 jobs · 2.2% failed" — from the server's totals only. */
export function metricsSummary(m: Pick<QueueMetrics, 'range' | 'totals'>): string {
  const total = m.totals.completed + m.totals.failed;
  const pct = total ? Math.round((m.totals.failed / total) * 1000) / 10 : 0;
  return `${METRICS_RANGE_TEXT[m.range]} · ${total.toLocaleString('en-GB')} job${total === 1 ? '' : 's'} · ${pct}% failed`;
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

/** `GET /admin/ai/overview` — configuration and health METADATA only (never a key, a prompt or a transcript). */
export interface AiAdminOverview {
  platformEnabled: boolean;
  provider: string | null;
  model: string | null;
  modelAllowlisted: boolean;
  credentialsConfigured: boolean;
  externalProvider: boolean;
  /** Why AI is unavailable (fixed codes + names-only messages; never a value). Absent on an older server. */
  readiness?: { ready: boolean; problems: Array<{ code: string; message: string }> };
  /** The configured catalogue entry's facts (approval scope, production approval, region, price). */
  modelFacts?: {
    id: string;
    label: string;
    provider: string;
    dataRegion: string;
    approved: boolean;
    approvalScope: string | null;
    productionApproved: boolean;
    priceUsdPerMTok: { input: number; output: number };
    verifiedAt: string;
  } | null;
  devRealProvidersAllowed?: boolean;
  telemetry: 'disabled';
  limits: {
    maxOutputTokens: number;
    maxSteps: number;
    maxInputChars: number;
    orgDailyTokenBudget: number;
    /** AI_DAILY_BUDGET_USD: estimated provider cost per organisation per UTC day. */
    dailyBudgetUsd?: number;
    turnTokenReservation: number;
    userRatePerMinute: number;
    orgMaxActiveTurns: number;
    turnTimeoutSeconds: number;
    historyMessages: number;
    messagesPerConversation: number;
    storedCharsPerMessage: number;
    toolRows: number;
  };
  retention: { days: number; mode: 'off' | 'report' | 'purge' | string; intervalMinutes: number };
  queue: { name: 'rab-ai'; available: boolean; waiting?: number; active?: number; delayed?: number; failed?: number; completed?: number };
  tools: Array<{ name: string; kind: string; permission: string; maxRows: number }>;
}

/** One organisation's AI usage COUNTERS for a UTC day range (`GET /admin/ai/usage`). */
export interface AiAdminUsageRow {
  organisationId: string;
  organisationName: string | null;
  aiEnabled: boolean;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  failedTurns: number;
  cancelledTurns: number;
  toolCalls: number;
}
export interface AiAdminUsage {
  from: string;
  to: string;
  organisations: AiAdminUsageRow[];
}
export interface AiOrganisationSetting {
  organisationId: string;
  enabled: boolean;
  updatedAt: string | null;
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

/**
 * Writes a server-CONFIRMED change of one user into every cached Admin-panel user row (search results, recent users, the
 * card's summary), so a card never offers an action the server has just made impossible (e.g. "Reset 2FA" right after a
 * reset). Only for outcomes the server answered; the queries are refetched afterwards anyway.
 */
export function patchCachedAdminUser(
  qc: QueryClient,
  userId: string,
  patch: Partial<Omit<AdminUser, 'twoFactor'>> & { twoFactor?: Partial<TwoFactorState> },
): void {
  const apply = <T extends AdminUser>(row: T): T =>
    row && row.id === userId
      ? { ...row, ...patch, twoFactor: { ...row.twoFactor, ...(patch.twoFactor ?? {}) } }
      : row;
  qc.setQueriesData<unknown>({ queryKey: ['admin', 'users'] }, (data: unknown) => {
    if (Array.isArray(data)) return data.map((row) => apply(row as AdminUser));
    if (data && typeof data === 'object' && (data as AdminUser).id === userId) return apply(data as AdminUser);
    return data;
  });
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
  queueMetrics: async (queue: string, range: MetricsRange) => (await api.get<QueueMetrics>(`/admin/queues/${encodeURIComponent(queue)}/metrics`, { params: { range } })).data,
  jobs: async (queue: string, state: JobState) => (await api.get<{ items: JobItem[]; total: number | null }>(`/admin/queues/${encodeURIComponent(queue)}/jobs`, { params: { state, limit: 25 } })).data,
  failedOutbox: async () => (await api.get<FailedOutboxItem[]>('/admin/outbox/failed', { params: { limit: 50 } })).data,
  config: async () => (await api.get<AdminConfig>('/admin/config')).data,
  email: async () => (await api.get<EmailSettings>('/admin/config/email')).data,
  environment: async () => (await api.get<EnvironmentRow[]>('/admin/config/environment')).data,
  security: async () => (await api.get<SecurityReport>('/admin/security')).data,
  workspaces: async (cursor?: string) => (await api.get<Page<WorkspaceRow>>('/admin/workspaces', { params: cursor ? { cursor } : undefined })).data,
  aiOverview: async () => (await api.get<AiAdminOverview>('/admin/ai/overview')).data,
  aiUsage: async (from: string, to: string) => (await api.get<AiAdminUsage>('/admin/ai/usage', { params: { from, to, limit: 200 } })).data,
  aiOrganisationSetting: async (organisationId: string) => (await api.get<AiOrganisationSetting>(`/admin/ai/organisations/${encodeURIComponent(organisationId)}/setting`)).data,
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
  /**
   * B3 (admin panel follow-up): `{ reason }` only. The server requires a recent step-up of this session ('platform.admin.
   * grant' / 'platform.admin.revoke') — the dialog's password/code go to `POST /auth/step-up` first (`stepUpIfGiven`), an
   * SSO-only admin re-authenticates through the shared StepUpHost. Never yourself, never the last admin (409).
   */
  grantPlatformAdmin: async (userId: string, reason: string) =>
    (await api.post<{ granted: boolean; revokedSessions: number }>(`/admin/platform-admins/${encodeURIComponent(userId)}`, { reason })).data,
  revokePlatformAdmin: async (userId: string, reason: string) => (await api.delete<{ revoked: boolean }>(`/admin/platform-admins/${encodeURIComponent(userId)}`, { data: { reason } })).data,
  /** Step-up pattern too ('organisation.suspend' / 'organisation.reactivate'): no inline password; reason required. */
  suspendOrganisation: async (id: string, body: { reason: string; confirmSlug: string }) =>
    (await api.post<OrganisationSuspensionStatus>(`/admin/organisations/${encodeURIComponent(id)}/suspend`, body)).data,
  reactivateOrganisation: async (id: string, body: { reason: string }) => (await api.post<OrganisationSuspensionStatus>(`/admin/organisations/${encodeURIComponent(id)}/reactivate`, body)).data,
  resendCeoInvite: async (id: string, reason: string) =>
    (await api.post<{ sendNumber: number; expiresAt: string; queued: boolean }>(`/admin/organisations/${encodeURIComponent(id)}/ceo-invite/resend`, { reason })).data,
  /**
   * The per-organisation AI switch (default OFF). Needs a recent step-up ('organisation.ai.update') — the dialog's
   * password/code go to `POST /auth/step-up` first (`stepUpIfGiven`); audited in the TARGET organisation.
   */
  setAiOrganisationSetting: async (organisationId: string, enabled: boolean, reason: string) =>
    (await api.put<AiOrganisationSetting>(`/admin/ai/organisations/${encodeURIComponent(organisationId)}/setting`, { enabled, reason })).data,
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

export interface OrganisationSuspensionStatus {
  organisationId: string;
  suspended: boolean;
  suspendedAt: string | null;
}

/** User-facing text for the Admin panel's own server codes (the shared normaliser covers everything else). */
export const ADMIN_ERROR_TEXT: Record<string, string> = {
  PLATFORM_ADMIN_SELF_REMOVAL: 'You can’t remove yourself as a platform admin. Ask another platform admin to do it.',
  LAST_PLATFORM_ADMIN: 'This is the last platform admin. Add another platform admin first.',
  SESSIONS_REVOKE_SELF: 'To sign yourself out of other devices, use Settings → Profile → Devices.',
  STEP_UP_REQUIRED: 'Confirm it’s you to continue: enter your password (and your 2FA code if you use 2FA), then try again.',
  STEP_UP_MFA_INVALID: 'That code didn’t work. Enter the current code from your authenticator app.',
  STEP_UP_UNAVAILABLE: 'Confirming your identity is temporarily unavailable. Try again in a moment.',
  INSPECT_READ_ONLY: 'Admin Inspect is read-only. End the inspect session to make changes.',
  QUEUE_ACTION_NOT_ALLOWED: 'This action isn’t available on this queue.',
  INVALID_JOB_IDS: 'Select between 1 and 100 jobs.',
  NO_BODY: 'This email carried a one-time link that was cleared. Ask the user to request a new link.',
  DELIVERY_UNCERTAIN: 'The provider may already have sent this email, so it was not replayed.',
};

/** User-facing text for the reset contract's error codes (the shared normaliser covers everything else). */
export const RESET_2FA_ERROR_TEXT: Record<string, string> = {
  STEP_UP_REQUIRED: ADMIN_ERROR_TEXT.STEP_UP_REQUIRED!,
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
  'ai.organisation_setting_changed': 'AI switch changed',
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
