// Admin panel capture fixtures (2026-10-24) — answers the NEW Admin panel endpoints for documentation / design-parity
// screenshots only. Same rules as fixtures.cjs: the UI is the real rab-front build; every response here is synthetic and
// fictional (`@example.test`, made-up organisations) and is intercepted inside the browser with `page.route`. Nothing
// reaches a real API. Shapes mirror the server's allowlist mappers (rab-server …/platform-admin/admin-panel.mappers.ts).
'use strict';

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ME = 'u-robin';
const users = [
  { id: 'a1f0c1de-0000-4000-8000-0000000000a1', organisationId: 'o-1', organisationName: 'Example Agency Ltd', firstName: 'Alex', lastName: 'Morgan', email: 'alex.morgan@example-agency.test', status: 'active', createdAt: ago(40 * DAY), lastLoginAt: ago(2 * HOUR), isPlatformAdmin: false, roleKeys: ['ceo'], roles: ['CEO'], twoFactor: { enabled: true, enabledAt: ago(1 * DAY), recoveryCodesRemaining: 8, recoveryCodesTotal: 10 } },
  { id: 'b2f0c1de-0000-4000-8000-0000000000b2', organisationId: 'o-1', organisationName: 'Example Agency Ltd', firstName: 'Sam', lastName: 'Patel', email: 'sam.patel@example-agency.test', status: 'active', createdAt: ago(20 * DAY), lastLoginAt: ago(3 * HOUR), isPlatformAdmin: false, roleKeys: ['venue_manager'], roles: ['Venue Manager'], twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: null, recoveryCodesTotal: null } },
  { id: 'c3f0c1de-0000-4000-8000-0000000000c3', organisationId: 'o-2', organisationName: 'Sample Events Co', firstName: 'Staff', lastName: 'Test 1', email: 'stafftest1@example.test', status: 'active', createdAt: ago(1 * DAY), lastLoginAt: ago(30 * MIN), isPlatformAdmin: false, roleKeys: ['staff'], roles: ['Staff'], twoFactor: { enabled: true, enabledAt: ago(1 * DAY), recoveryCodesRemaining: 10, recoveryCodesTotal: 10 } },
  { id: 'd4f0c1de-0000-4000-8000-0000000000d4', organisationId: 'o-hq', organisationName: 'Crewflow HQ', firstName: 'Jordan', lastName: 'Lee', email: 'jordan.lee@example.test', status: 'active', createdAt: ago(10 * DAY), lastLoginAt: ago(1 * DAY), isPlatformAdmin: true, roleKeys: ['manager'], roles: ['Manager'], twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: null, recoveryCodesTotal: null } },
];

function adminRoutes(state) {
  const json = (status, body) => ({ status, body });
  return (method, p, q) => {
    if (method === 'GET' && p === '/admin/general') return json(200, { version: 'v0.3.0', latestVersion: null, commit: 'efc4709' });
    if (method === 'GET' && p === '/admin/overview')
      return json(200, { organisations: { total: 7, active: 6, suspended: 1 }, users: { total: 1284, signedInLast7Days: 412 }, sessions: { active: 538, platformAdminSessionsToday: 31 }, platformAdmins: { active: 2 }, workspaces: { ready: 11, creating: 1, failed: 1, other: 0 } });
    if (method === 'GET' && p === '/admin/migrations') return json(200, { applied: 213, latest: 'AuditLogOrganisationActionIndex1786720110000', pending: 0 });
    if (method === 'GET' && p === '/admin/users/search') {
      const qq = (q.get('q') || '').toLowerCase();
      const role = q.get('role') || '';
      let list = users.filter((u) => !qq || `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(qq));
      if (role === 'platform_admin') list = list.filter((u) => u.isPlatformAdmin);
      else if (role) list = list.filter((u) => u.roleKeys.includes(role));
      if (state.resetDone) list = list.map((u) => (u.id === users[0].id ? { ...u, twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: null, recoveryCodesTotal: null } } : u));
      return json(200, list.slice(0, Number(q.get('limit') || 25)));
    }
    const summary = p.match(/^\/admin\/users\/([^/]+)\/summary$/);
    if (method === 'GET' && summary) {
      const u = users.find((x) => x.id === summary[1]);
      return u ? json(200, { ...u, sessions: { total: 2, managerWeb: 0, venueManagerApp: 2, staffApp: 0 }, lastSignInProvider: 'google', failedSignIns24h: 0 }) : json(404, { message: 'Not found' });
    }
    const reset = p.match(/^\/admin\/users\/([^/]+)\/mfa\/reset$/);
    if (method === 'POST' && reset) {
      state.resetDone = true;
      return json(200, { reset: true, revokedSessions: 3 });
    }
    if (method === 'GET' && p === '/admin/platform-admins')
      return json(200, [
        { userId: ME, firstName: 'Robin', lastName: 'Ashford', email: 'robin.ashford@example.test', organisationName: 'Crewflow HQ', twoFactorEnabled: true, grantedAt: ago(52 * DAY), grantedBy: null, isYou: true },
        { userId: users[3].id, firstName: 'Jordan', lastName: 'Lee', email: 'jordan.lee@example.test', organisationName: 'Crewflow HQ', twoFactorEnabled: false, grantedAt: ago(10 * DAY), grantedBy: { userId: ME, name: 'Robin Ashford' }, isYou: false },
      ]);
    if (method === 'GET' && p === '/admin/lookup/organisations')
      return json(200, [{ id: '9b20aa11-0000-4000-8000-0000000011c7', name: 'Example Agency Ltd', slug: 'example-agency', suspended: false, suspendedAt: null, createdAt: ago(60 * DAY), ceo: { userId: users[0].id, name: 'Alex Morgan', email: users[0].email, status: 'active', activated: true } }]);
    if (method === 'GET' && /^\/admin\/lookup\/organisations\/[^/]+\/summary$/.test(p))
      return json(200, { id: 'o-hq', name: 'Crewflow HQ', slug: 'crewflow-hq', suspended: false, suspendedAt: null, createdAt: ago(90 * DAY), ceo: { userId: ME, name: 'Robin Ashford', email: 'robin.ashford@example.test', status: 'active', activated: true, twoFactorEnabled: true }, members: { active: 214 }, workspaces: { total: 3, ready: 3, creating: 0, failed: 0 } });
    if (method === 'GET' && p === '/admin/health/report')
      return json(200, {
        checkedAt: ago(12_000),
        attention: 2,
        cards: [
          { key: 'database', status: 'healthy', detail: 'PostgreSQL · 18 ms · pool 4 of 10 in use', latencyMs: 18 },
          { key: 'redis', status: 'warning', detail: 'Reachable · 1 ms · no password set', latencyMs: 1 },
          { key: 'worker', status: 'healthy', detail: 'Heartbeat 4 s ago', latencyMs: null },
          { key: 'provisioner', status: 'healthy', detail: 'Heartbeat 2 s ago', latencyMs: null },
          { key: 'email', status: 'healthy', detail: 'Driver: Resend (from server settings) · API key set · not probed', latencyMs: null },
          { key: 'storage', status: 'warning', detail: 'S3-compatible · probe 1240 ms', latencyMs: 1240 },
        ],
      });
    if (method === 'GET' && p === '/admin/queues')
      return json(200, {
        mode: 'interval',
        metrics: { available: false, reason: 'WORKER_METRICS_DISABLED' },
        worker: { heartbeatAgeSeconds: 4, stale: false, scheduler: null },
        queues: [
          { name: 'rab-email', kind: 'consumer', counts: { failed: 3, active: 0, waiting: 0, delayed: 1, completed: 412, paused: 0, prioritized: 0 }, actions: { retry: ['failed'], delete: [], lockedReason: null } },
          { name: 'rab-push', kind: 'consumer', counts: { failed: 1, active: 0, waiting: 0, delayed: 0, completed: 980, paused: 0, prioritized: 0 }, actions: { retry: ['failed'], delete: [], lockedReason: null } },
          { name: 'rab-shift-statements', kind: 'consumer', counts: { failed: 0, active: 0, waiting: 0, delayed: 0, completed: 31, paused: 0, prioritized: 0 }, actions: { retry: [], delete: [], lockedReason: 'Payroll statements cannot be retried or deleted from here.' } },
        ],
        cycles: [
          { source: 'worker', loop: 'email-dispatch', runs: 1024, p50Ms: 7, p95Ms: 21, maxMs: 90, lastMs: 8, succeeded: 40, idle: 984, failed: 0, skipped: 0, measuredAt: ago(30_000) },
          { source: 'worker', loop: 'offer-expiry', runs: 312, p50Ms: 9, p95Ms: 85, maxMs: 85, lastMs: 8, succeeded: 312, idle: 0, failed: 0, skipped: 0, measuredAt: ago(30_000) },
          { source: 'provisioner', loop: 'workspace-provisioning', runs: 720, p50Ms: 12, p95Ms: 40, maxMs: 410, lastMs: 11, succeeded: 2, idle: 718, failed: 0, skipped: 0, measuredAt: ago(20_000) },
        ],
        lastRuns: [],
      });
    const jobs = p.match(/^\/admin\/queues\/([^/]+)\/jobs$/);
    if (method === 'GET' && jobs) {
      const items = jobs[1] === 'rab-email' && q.get('state') === 'failed'
        ? [
            { id: 'email-outbox.71d0c3aa.attempt.3', name: 'send', state: 'failed', createdAt: ago(3 * HOUR), processedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR), attemptsMade: 5, maxAttempts: 5, errorClass: 'PROVIDER_429', organisationId: 'o-1', entityId: null, scheduler: false },
            { id: 'email-outbox.7e11a0bb.attempt.1', name: 'send', state: 'failed', createdAt: ago(3 * HOUR), processedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR), attemptsMade: 5, maxAttempts: 5, errorClass: 'PROVIDER_429', organisationId: 'o-1', entityId: null, scheduler: false },
            { id: 'email-outbox.8a2f19cc.attempt.2', name: 'send', state: 'failed', createdAt: ago(4 * HOUR), processedAt: ago(4 * HOUR), finishedAt: ago(4 * HOUR), attemptsMade: 1, maxAttempts: 5, errorClass: 'UNRECOVERABLE', organisationId: 'o-2', entityId: null, scheduler: false },
          ]
        : [];
      return json(200, { items, total: items.length });
    }
    if (method === 'GET' && p === '/admin/outbox/failed')
      return json(200, [
        { kind: 'email', id: '71d0c3aa-0000-4000-8000-0000000000c3', organisationId: '9b20aa11-0000-4000-8000-0000000011c7', workspaceId: null, type: 'NOTIFICATION', attempts: 5, lastErrorCode: 'PROVIDER_429', failedAt: ago(2 * HOUR), createdAt: ago(3 * HOUR), replayable: true },
        { kind: 'email', id: '8a2f19cc-0000-4000-8000-000000000019', organisationId: 'a01f0000-0000-4000-8000-00000000009d', workspaceId: null, type: 'PASSWORD_RESET', attempts: 1, lastErrorCode: 'INVALID_RECIPIENT', failedAt: ago(4 * HOUR), createdAt: ago(4 * HOUR), replayable: false },
        { kind: 'push', id: '0c447e00-0000-4000-8000-00000000007e', organisationId: '9b20aa11-0000-4000-8000-0000000011c7', workspaceId: null, type: 'PUSH', attempts: 1, lastErrorCode: 'DEVICE_UNREGISTERED', failedAt: ago(1 * DAY), createdAt: ago(1 * DAY) },
      ]);
    if (method === 'GET' && p === '/admin/config') return json(200, { authentication: { method: 'email_password' }, smtp: {}, storage: { driver: 'S3' }, maintenanceMode: { enabled: Boolean(state.maintenance), message: null } });
    if (method === 'GET' && p === '/admin/config/email') return json(200, { driver: 'RESEND', fromAddress: 'no-reply@example-crewflow.test', replyToSet: false, deliveryEnabled: true, credential: 'set' });
    if (method === 'GET' && p === '/admin/config/environment')
      return json(200, [
        ['App', 'NODE_ENV', 'value', 'production', 'env'], ['App', 'APP_VERSION', 'value', 'v0.3.0', 'env'], ['App', 'APP_GIT_COMMIT', 'value', 'efc4709', 'env'], ['App', 'APP_URL', 'set', null, 'env'],
        ['App', 'ACCOUNTS_URL', 'set', null, 'env'], ['Secrets', 'APP_SECRET', 'set', null, 'env (secret)'], ['Secrets', 'APP_AUTH_CACHE_HMAC_KEY', 'set', null, 'env (secret)'],
        ['Database', 'DATABASE_URL', 'set', null, 'env (secret)'], ['Redis', 'REDIS_URL', 'set', null, 'env (secret)'], ['Redis', 'BULLMQ_PREFIX', 'value', 'crewflow:production:bull', 'env'],
        ['Worker', 'WORKER_SCHEDULER', 'value', 'interval', 'env'], ['Storage', 'STORAGE_DRIVER', 'value', 'S3', 'env'], ['Storage', 'S3_BUCKET', 'value', 'rab-production-storage', 'env'],
        ['Email', 'EMAIL_DRIVER', 'value', 'RESEND', 'env'], ['Email', 'EMAIL_FROM_ADDRESS', 'value', 'no-reply@example-crewflow.test', 'env'], ['Email', 'RESEND_API_KEY', 'set', null, 'env (secret)'],
      ].map(([group, key, st, value, source]) => ({ group, key, state: st, value, source })));
    if (method === 'GET' && p === '/admin/security')
      return json(200, {
        switches: [
          { label: 'Users may turn on 2FA', variable: 'AUTH_MFA_ENROLMENT_ENABLED', state: 'On', recommended: 'On', tone: 'ok' },
          { label: 'Force 2FA for any role (4 settings)', variable: 'AUTH_MFA_ENFORCE_*', state: 'Off', recommended: 'Off: 2FA is optional (owner policy)', tone: 'neutral' },
          { label: 'Ask for the code on mobile once turned on', variable: 'AUTH_MFA_MOBILE_POLICY', state: 'require', recommended: 'require (after mobile 2FA screens ship)', tone: 'ok' },
          { label: 'Host routing for workspace addresses', variable: 'WORKSPACE_HOST_ROUTING_ENABLED', state: 'Off', recommended: 'When DNS is ready', tone: 'neutral' },
          { label: '__Host- cookie names', variable: 'AUTH_COOKIE_HOST_PREFIX_ENABLED', state: 'Off', recommended: 'On', tone: 'warn' },
          { label: 'Refuse reused secrets across key roles', variable: 'APP_KEY_SEPARATION_REQUIRED', state: 'Off', recommended: 'On', tone: 'warn' },
          { label: 'Accept tokens signed with legacy APP_SECRET', variable: 'APP_JWT_LEGACY_VERIFY_ENABLED', state: 'On', recommended: 'Off', tone: 'bad' },
          { label: 'Workspace subdomain origin trust', variable: 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', state: 'Off', recommended: 'Off until host routing', tone: 'ok' },
          { label: 'Workspace schemas hold business data', variable: 'HWS_RUNTIME_ENABLED', state: 'Off', recommended: 'After the production rehearsal', tone: 'neutral' },
        ],
        signingKeys: [
          { kid: 'derived-v1', use: 'signs_and_verifies', derivedFrom: 'HKDF purpose key from APP_SECRET', status: 'active', verified24h: null },
          { kid: 'legacy', use: 'verifies_only', derivedFrom: 'Raw APP_SECRET (legacy)', status: 'accepted', verified24h: null },
        ],
        encryptionKeys: { activeKid: 'k2026-10', kids: ['k2026-10'] },
      });
    if (method === 'GET' && p === '/admin/workspaces')
      return json(200, {
        nextCursor: null,
        items: [
          { workspaceId: 'w-1', organisationId: 'o-1', organisationName: 'Example Agency Ltd', workspaceName: 'Main', schemaName: 'workspace_3c9e00000000000000000000000000041', schemaStatus: 'READY', schemaVersion: 1, moduleVersion: 17, registryStatus: 'READY', driftStatus: 'OK', error: null, updatedAt: ago(3 * DAY) },
          { workspaceId: 'w-2', organisationId: 'o-2', organisationName: 'Sample Events Co', workspaceName: 'Events', schemaName: 'workspace_a01f0000000000000000000000000009d', schemaStatus: 'CREATING', schemaVersion: null, moduleVersion: null, registryStatus: 'PROVISIONING', driftStatus: 'UNCHECKED', error: null, updatedAt: ago(2 * MIN) },
          { workspaceId: 'w-3', organisationId: 'o-3', organisationName: 'Demo Hospitality', workspaceName: 'North', schemaName: 'workspace_77b20000000000000000000000000000e', schemaStatus: 'FAILED', schemaVersion: null, moduleVersion: null, registryStatus: 'FAILED', driftStatus: 'NOT_READY', error: 'PROVISION_FAILED 42P07', updatedAt: ago(1 * DAY) },
        ],
      });
    if (method === 'GET' && p === '/admin/audit')
      return json(200, {
        nextCursor: null,
        items: [
          { id: 'e1', action: 'admin.queue_jobs_retried', organisationId: 'o-hq', organisationName: 'Crewflow HQ', createdAt: ago(20 * MIN), actor: { userId: ME, name: 'Robin Ashford' }, target: null, entity: null, reason: 'Resend rate limit cleared', detail: { queue: 'rab-email', count: 1 } },
          { id: 'e2', action: 'admin.user_searched', organisationId: 'o-hq', organisationName: 'Crewflow HQ', createdAt: ago(31 * MIN), actor: { userId: ME, name: 'Robin Ashford' }, target: { userId: users[1].id, name: 'Sam Patel' }, entity: null, reason: null, detail: { resultCount: 1, kind: 'email' } },
          { id: 'e3', action: 'email.replay_requested', organisationId: 'o-2', organisationName: 'Sample Events Co', createdAt: ago(17 * HOUR), actor: { userId: users[3].id, name: 'Jordan Lee' }, target: null, entity: { type: 'email_outbox', id: '51aa00f0-0000-4000-8000-0000000000f0' }, reason: null, detail: {} },
          { id: 'e4', action: 'user.mfa_reset_by_admin', organisationId: 'o-1', organisationName: 'Example Agency Ltd', createdAt: ago(2 * DAY), actor: { userId: ME, name: 'Robin Ashford' }, target: { userId: users[0].id, name: 'Alex Morgan' }, entity: null, reason: 'Lost phone, identity checked by call', detail: { revokedSessions: 3 } },
          { id: 'e5', action: 'platform_admin.granted', organisationId: 'o-hq', organisationName: 'Crewflow HQ', createdAt: ago(10 * DAY), actor: { userId: ME, name: 'Robin Ashford' }, target: { userId: users[3].id, name: 'Jordan Lee' }, entity: null, reason: null, detail: {} },
          { id: 'e6', action: 'organisation.suspended', organisationId: 'o-9', organisationName: 'Old Pilot Agency', createdAt: ago(21 * DAY), actor: { userId: ME, name: 'Robin Ashford' }, target: null, entity: { type: 'organisation', id: '0ddc0000-0000-4000-8000-000000000009' }, reason: 'Contract ended', detail: {} },
        ],
      });
    return null;
  };
}

/** Registers the admin routes AFTER fixtures.install (Playwright: the most recently added matching route wins). */
async function installAdmin(page, opts = {}) {
  const state = { resetDone: false, maintenance: Boolean(opts.maintenance) };
  const handle = adminRoutes(state);
  await page.route('**/rest/v1/admin/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^.*\/rest\/v1/, '');
    if (req.method() === 'OPTIONS') return r.fallback();
    const res = handle(req.method(), p, url.searchParams);
    if (!res) return r.fallback();
    return r.fulfill({ status: res.status, headers: { 'access-control-allow-origin': opts.origin, 'access-control-allow-credentials': 'true', 'content-type': 'application/json' }, body: JSON.stringify(res.body) });
  });
  return state;
}

module.exports = { installAdmin, ME };
