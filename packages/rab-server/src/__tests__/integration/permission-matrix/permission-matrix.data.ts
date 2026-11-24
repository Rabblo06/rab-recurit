/**
 * The permission matrix: every authenticated HTTP route x every role (rab-workforce-architecture.md §7), one row per route.
 * Reviewed data, not derived at test time. permission-matrix.integration.spec.ts discovers the live route table from the
 * real AppModule and fails when a route is missing here (a NEW endpoint fails CI until someone classifies it in this file),
 * when a row names a route that no longer exists, and when a live request as any role does not get the cell's outcome.
 *
 * Columns (MATRIX_ROLES), each a real identity built by the test-identity factory with its production role defaults and
 * signed into the application a real client of that role uses:
 *   padm   platform administrator: the organisation CEO holding the platform-admin claim (§7 "Super Admin"), manager_web
 *   ceo    an organisation CEO without the platform-admin claim, manager_web
 *   mgr    an Internal Manager (the `manager` system role), manager_web
 *   vmgr   a Venue Manager, venue_manager_app
 *   staff  a Staff member, staff_app
 *
 * Cells:
 *   ok    passes every guard layer (session, application, permission, platform admin), observed: the response reached
 *         the global interceptors. For a record route (`:id`, ...) and a validated body/query the probe stops at the
 *         boundary (record-id interceptor 404 / ValidationPipe 400), so `ok` there pins the guard chain only; for a read
 *         without a record id the handler runs and the cell is what it answers this role
 *   403   the route exists and this role categorically lacks it (permission flag, application, platform admin)
 *   404   hidden from this role: the route answers Not found (AI routes while the organisation's AI switch is off, as on a
 *         new organisation; a GET whose scope is empty for this role)
 *
 * What a cell does NOT say: whether one particular record is in this caller's scope. Per-record 404-not-403 (another
 * tenant, another workspace, another venue, someone else's shift) is a layer-2/layer-4 rule proved by the abuse-case
 * suites (§1.2); the matrix pins layer 1 (the guard chain) for every route at once. To keep the probe free of side
 * effects, a request that would mutate data never reaches its handler (see PROBE_EXECUTES_HANDLER and the spec's header).
 *
 * Unauthenticated access is not a column: auth-route-inventory.integration.spec.ts proves every route either runs
 * JwtAuthGuard first or is on its public allow-list; public routes are not rows here.
 *
 * Changing a cell is a permission change. Say why in the PR, and keep THREAT-MODEL.md and §7 in step.
 */

export const MATRIX_ROLES = ['platform_admin', 'ceo', 'manager', 'venue_manager', 'staff'] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

export const MATRIX_CELLS = ['ok', '403', '404'] as const;
export type MatrixCell = (typeof MATRIX_CELLS)[number];

/**
 * Mutating routes with no record id and no validated body: the probe cannot stop them before their handler, so for the
 * cells that pass the guards the handler really runs. Each is listed with a decision, and the spec fails when this list
 * and the route table disagree (a new such route must be classified here first):
 *   run       harmless against the matrix fixtures (nothing to delete, an empty upload, an idempotent switch); runs after
 *             every read-only probe
 *   run-last  ends the probing session itself; runs after every other probe of that role
 */
export const PROBE_EXECUTES_HANDLER: Readonly<Record<string, 'run' | 'run-last'>> = {
  'DELETE /rest/v1/ai/settings/assistant': 'run', // AI is off: the AI guard answers 404 before the handler
  'DELETE /rest/v1/manager-workspaces/me/logo': 'run', // the fixture workspace has no logo
  'DELETE /rest/v1/profile/avatar': 'run', // the fixture identity has no avatar
  'DELETE /rest/v1/profile/sessions': 'run', // revokes the caller's OTHER sessions; each probe identity has one
  'POST /rest/v1/admin/inspect/end': 'run', // no inspect session is open
  'POST /rest/v1/auth/login-handoff': 'run', // mints a single-use hand-off token nobody redeems
  'POST /rest/v1/manager-workspaces/me/complete-onboarding': 'run', // idempotent onboarding flag on the fixture workspace
  'POST /rest/v1/manager-workspaces/me/logo': 'run', // JSON body, no file: refused as an empty upload
  'POST /rest/v1/managers/initial-manager-invite/resend': 'run', // no Initial Manager invitation exists
  'POST /rest/v1/managers/initial-manager-invite/revoke': 'run', // no Initial Manager invitation exists
  'POST /rest/v1/notifications/read-all': 'run', // the fixture identity has no notifications
  'POST /rest/v1/profile/avatar': 'run', // JSON body, no file: refused as an empty upload
  'POST /rest/v1/push/devices/deactivate-all': 'run', // the fixture identity has no push devices
  'POST /rest/v1/profile/sessions/logout-all': 'run-last', // revokes every session of the caller, including this one
};

/**
 * Reads probed with one undeclared query parameter instead of being executed: the global ValidationPipe answers 400 once
 * the guards have passed, before the handler runs. Only for a GET whose answer would otherwise depend on state outside
 * the matrix fixtures (the spec fails if a listed route has no validated query DTO).
 */
export const READ_PROBED_BY_QUERY: Readonly<Record<string, string>> = {
  'GET /rest/v1/admin/outbox/failed': 'scans every organisation and workspace of the database, so its answer depends on what other suites left behind',
};

/**
 * Values for path parameters that do not name a record (record ids get a malformed id, see the spec). `:queue` is the
 * real e-mail queue name (CONSUMER_QUEUES.email, filled in by the spec), so GET /admin/queues/:queue/* reads a real queue.
 */
export const PATH_PARAM_SAMPLES: Readonly<Record<string, string>> = {
  tier: 'standard',
  name: 'matrix-probe',
};

//                                                                                             padm ceo  mgr  vmgr staff
// prettier-ignore
export const PERMISSION_MATRIX: Readonly<Record<string, string>> = {
  // /rest/v1/admin
  'GET /rest/v1/admin/ai/organisations/:organisationId/setting':                              'ok   403  403  403  403',
  'PUT /rest/v1/admin/ai/organisations/:organisationId/setting':                              'ok   403  403  403  403',
  'GET /rest/v1/admin/ai/overview':                                                           'ok   403  403  403  403',
  'GET /rest/v1/admin/ai/usage':                                                              'ok   403  403  403  403',
  'GET /rest/v1/admin/audit':                                                                 'ok   403  403  403  403',
  'GET /rest/v1/admin/config':                                                                'ok   403  403  403  403',
  'GET /rest/v1/admin/config/email':                                                          'ok   403  403  403  403',
  'POST /rest/v1/admin/config/email/test':                                                    'ok   403  403  403  403',
  'GET /rest/v1/admin/config/environment':                                                    'ok   403  403  403  403',
  'PATCH /rest/v1/admin/config/maintenance-mode':                                             'ok   403  403  403  403',
  'PATCH /rest/v1/admin/config/smtp':                                                         'ok   403  403  403  403',
  'POST /rest/v1/admin/config/smtp/test':                                                     'ok   403  403  403  403',
  'GET /rest/v1/admin/general':                                                               'ok   403  403  403  403',
  'GET /rest/v1/admin/health':                                                                'ok   403  403  403  403',
  'GET /rest/v1/admin/health/report':                                                         'ok   403  403  403  403',
  'POST /rest/v1/admin/inspect/:targetUserId':                                                'ok   403  403  403  403',
  'POST /rest/v1/admin/inspect/end':                                                          'ok   403  403  403  403',
  'GET /rest/v1/admin/lookup/organisations':                                                  'ok   403  403  403  403',
  'GET /rest/v1/admin/lookup/organisations/:organisationId/summary':                          'ok   403  403  403  403',
  'GET /rest/v1/admin/migrations':                                                            'ok   403  403  403  403',
  'GET /rest/v1/admin/organisation-invitations':                                              'ok   403  403  403  403',
  'POST /rest/v1/admin/organisation-invitations':                                             'ok   403  403  403  403',
  'POST /rest/v1/admin/organisation-invitations/:invitationId/resend':                        'ok   403  403  403  403',
  'POST /rest/v1/admin/organisation-invitations/:invitationId/revoke':                        'ok   403  403  403  403',
  'GET /rest/v1/admin/organisations':                                                         'ok   403  403  403  403',
  'GET /rest/v1/admin/organisations/:organisationId':                                         'ok   403  403  403  403',
  'POST /rest/v1/admin/organisations/:organisationId/ceo-invite/resend':                      'ok   403  403  403  403',
  'POST /rest/v1/admin/organisations/:organisationId/ceo-invite/revoke':                      'ok   403  403  403  403',
  'POST /rest/v1/admin/organisations/:organisationId/reactivate':                             'ok   403  403  403  403',
  'GET /rest/v1/admin/organisations/:organisationId/settings':                                'ok   403  403  403  403',
  'PATCH /rest/v1/admin/organisations/:organisationId/settings':                              'ok   403  403  403  403',
  'PATCH /rest/v1/admin/organisations/:organisationId/settings/domain':                       'ok   403  403  403  403',
  'POST /rest/v1/admin/organisations/:organisationId/settings/logo':                          'ok   403  403  403  403',
  'DELETE /rest/v1/admin/organisations/:organisationId/settings/logo':                        'ok   403  403  403  403',
  'PATCH /rest/v1/admin/organisations/:organisationId/settings/security':                     'ok   403  403  403  403',
  'POST /rest/v1/admin/organisations/:organisationId/suspend':                                'ok   403  403  403  403',
  'GET /rest/v1/admin/organisations/:organisationId/suspension':                              'ok   403  403  403  403',
  'GET /rest/v1/admin/outbox/failed':                                                         'ok   403  403  403  403',
  'POST /rest/v1/admin/outbox/organisations/:organisationId/emails/:emailId/replay':          'ok   403  403  403  403',
  'GET /rest/v1/admin/outbox/queues':                                                         'ok   403  403  403  403',
  'GET /rest/v1/admin/overview':                                                              'ok   403  403  403  403',
  'GET /rest/v1/admin/platform-admins':                                                       'ok   403  403  403  403',
  'POST /rest/v1/admin/platform-admins/:userId':                                              'ok   403  403  403  403',
  'DELETE /rest/v1/admin/platform-admins/:userId':                                            'ok   403  403  403  403',
  'GET /rest/v1/admin/queues':                                                                'ok   403  403  403  403',
  'GET /rest/v1/admin/queues/:queue/jobs':                                                    'ok   403  403  403  403',
  'POST /rest/v1/admin/queues/:queue/jobs/delete':                                            'ok   403  403  403  403',
  'POST /rest/v1/admin/queues/:queue/jobs/retry':                                             'ok   403  403  403  403',
  'GET /rest/v1/admin/queues/:queue/metrics':                                                 'ok   403  403  403  403',
  'GET /rest/v1/admin/recent-users':                                                          'ok   403  403  403  403',
  'GET /rest/v1/admin/security':                                                              'ok   403  403  403  403',
  'POST /rest/v1/admin/users/:userId/mfa/reset':                                              'ok   403  403  403  403',
  'POST /rest/v1/admin/users/:userId/sessions/revoke':                                        'ok   403  403  403  403',
  'GET /rest/v1/admin/users/:userId/summary':                                                 'ok   403  403  403  403',
  'GET /rest/v1/admin/users/search':                                                          'ok   403  403  403  403',
  'GET /rest/v1/admin/workspaces':                                                            'ok   403  403  403  403',

  // /rest/v1/ai
  'GET /rest/v1/ai/agents':                                                                   '404  404  404  403  403',
  'POST /rest/v1/ai/agents':                                                                  '404  404  404  403  403',
  'GET /rest/v1/ai/agents/:id':                                                               '404  404  404  403  403',
  'PATCH /rest/v1/ai/agents/:id':                                                             '404  404  404  403  403',
  'DELETE /rest/v1/ai/agents/:id':                                                            '404  404  404  403  403',
  'GET /rest/v1/ai/agents/:id/role':                                                          '404  404  404  403  403',
  'PUT /rest/v1/ai/agents/:id/role':                                                          '404  404  404  403  403',
  'POST /rest/v1/ai/agents/:id/triggers':                                                     '404  404  404  403  403',
  'PATCH /rest/v1/ai/agents/:id/triggers/:triggerId':                                         '404  404  404  403  403',
  'DELETE /rest/v1/ai/agents/:id/triggers/:triggerId':                                        '404  404  404  403  403',
  'POST /rest/v1/ai/agents/:id/triggers/:triggerId/disable':                                  '404  404  404  403  403',
  'POST /rest/v1/ai/agents/:id/triggers/:triggerId/enable':                                   '404  404  404  403  403',
  'GET /rest/v1/ai/availability':                                                             'ok   ok   ok   403  403',
  'GET /rest/v1/ai/capabilities':                                                             '404  404  404  403  403',
  'GET /rest/v1/ai/conversations':                                                            '404  404  404  403  403',
  'POST /rest/v1/ai/conversations':                                                           '404  404  404  403  403',
  'GET /rest/v1/ai/conversations/:id':                                                        '404  404  404  403  403',
  'DELETE /rest/v1/ai/conversations/:id':                                                     'ok   ok   ok   403  403',
  'GET /rest/v1/ai/conversations/:id/inputs':                                                 '404  404  404  403  403',
  'POST /rest/v1/ai/conversations/:id/inputs/:requestId/answer':                              '404  404  404  403  403',
  'POST /rest/v1/ai/conversations/:id/messages':                                              '404  404  404  403  403',
  'GET /rest/v1/ai/conversations/:id/proposals':                                              '404  404  404  403  403',
  'GET /rest/v1/ai/conversations/:id/stream':                                                 '404  404  404  403  403',
  'POST /rest/v1/ai/conversations/:id/turns/:turnId/cancel':                                  '404  404  404  403  403',
  'POST /rest/v1/ai/proposals/:id/approve':                                                   '404  404  404  403  403',
  'POST /rest/v1/ai/proposals/:id/reject':                                                    '404  404  404  403  403',
  'GET /rest/v1/ai/settings':                                                                 '404  404  404  403  403',
  'GET /rest/v1/ai/settings/assistant':                                                       '404  404  404  403  403',
  'PUT /rest/v1/ai/settings/assistant':                                                       '404  404  404  403  403',
  'DELETE /rest/v1/ai/settings/assistant':                                                    '404  404  404  403  403',
  'GET /rest/v1/ai/settings/instructions':                                                    '404  404  404  403  403',
  'PUT /rest/v1/ai/settings/instructions':                                                    '404  404  404  403  403',
  'DELETE /rest/v1/ai/settings/instructions':                                                 '404  404  404  403  403',
  'PUT /rest/v1/ai/settings/model-policy':                                                    '404  404  404  403  403',
  'GET /rest/v1/ai/settings/models':                                                          '404  404  404  403  403',
  'PUT /rest/v1/ai/settings/models/:tier':                                                    '404  404  404  403  403',
  'DELETE /rest/v1/ai/settings/models/:tier':                                                 '404  404  404  403  403',
  'GET /rest/v1/ai/settings/prompt-preview':                                                  '404  404  404  403  403',
  'GET /rest/v1/ai/settings/skills':                                                          '404  404  404  403  403',
  'POST /rest/v1/ai/settings/skills':                                                         '404  404  404  403  403',
  'PATCH /rest/v1/ai/settings/skills/:id':                                                    '404  404  404  403  403',
  'DELETE /rest/v1/ai/settings/skills/:id':                                                   '404  404  404  403  403',
  'POST /rest/v1/ai/settings/skills/:id/activate':                                            '404  404  404  403  403',
  'POST /rest/v1/ai/settings/skills/:id/deactivate':                                          '404  404  404  403  403',
  'POST /rest/v1/ai/settings/skills/builtin/:name/activate':                                  '404  404  404  403  403',
  'POST /rest/v1/ai/settings/skills/builtin/:name/deactivate':                                '404  404  404  403  403',
  'GET /rest/v1/ai/settings/tools':                                                           '404  404  404  403  403',
  'GET /rest/v1/ai/settings/usage':                                                           '404  404  404  403  403',
  'GET /rest/v1/ai/skills':                                                                   '404  404  404  403  403',

  // /rest/v1/attendance
  'GET /rest/v1/attendance':                                                                  'ok   ok   ok   403  403',
  'POST /rest/v1/attendance/:attendanceId/correct':                                           'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/check-in':                                                        '403  403  403  403  ok',
  'POST /rest/v1/attendance/clock-in':                                                        '403  403  403  403  ok',
  'POST /rest/v1/attendance/clock-out':                                                       '403  403  403  403  ok',
  'POST /rest/v1/attendance/geofence-exit':                                                   '403  403  403  403  ok',
  'GET /rest/v1/attendance/me/active':                                                        '403  403  403  403  ok',
  'GET /rest/v1/attendance/me/history':                                                       '403  403  403  403  ok',
  'GET /rest/v1/attendance/me/shift/:shiftId':                                                '403  403  403  403  ok',
  'GET /rest/v1/attendance/me/shift/:shiftId/check-in':                                       '403  403  403  403  ok',
  'GET /rest/v1/attendance/me/shift/:shiftId/team':                                           '403  403  403  403  ok',
  'GET /rest/v1/attendance/report/shift/:shiftId':                                            'ok   ok   ok   ok   403',
  'PATCH /rest/v1/attendance/report/shift/:shiftId/finalise':                                 'ok   ok   ok   ok   403',
  'GET /rest/v1/attendance/report/shift/:shiftId/reviews/:staffProfileId':                    'ok   ok   ok   ok   403',
  'PUT /rest/v1/attendance/report/shift/:shiftId/reviews/:staffProfileId':                    'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/attendance-review':   'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/clock-in-on-behalf':  'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/clock-out-on-behalf': 'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/confirm-no-show':     'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/record-attendance':   'ok   ok   ok   ok   403',
  'POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/reopen-no-show':      'ok   ok   ok   ok   403',
  'GET /rest/v1/attendance/report/shifts':                                                    'ok   ok   ok   ok   403',

  // /rest/v1/audit-logs
  'GET /rest/v1/audit-logs':                                                                  'ok   ok   ok   403  403',

  // /rest/v1/auth
  'GET /rest/v1/auth/capabilities':                                                           'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/google/reauthenticate':                                                 'ok   ok   ok   403  403',
  'POST /rest/v1/auth/login-handoff':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/auth/logout':                                                                'ok   ok   ok   ok   ok',
  'GET /rest/v1/auth/me':                                                                     'ok   ok   ok   ok   ok',
  'GET /rest/v1/auth/mfa':                                                                    'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/mfa/disable':                                                           'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/mfa/enrolment':                                                         'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/mfa/enrolment/confirm':                                                 'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/mfa/recovery-codes':                                                    'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/microsoft/reauthenticate':                                              'ok   ok   ok   403  403',
  'POST /rest/v1/auth/set-password':                                                          'ok   ok   ok   ok   ok',
  'POST /rest/v1/auth/step-up':                                                               'ok   ok   ok   403  403',

  // /rest/v1/dashboard
  'GET /rest/v1/dashboard/summary':                                                           'ok   ok   ok   403  403',

  // /rest/v1/files
  'GET /rest/v1/files/:fileId':                                                               'ok   ok   ok   ok   ok',
  'POST /rest/v1/files/:fileId/complete':                                                     'ok   ok   ok   ok   ok',
  'GET /rest/v1/files/:fileId/download':                                                      'ok   ok   ok   ok   ok',
  'POST /rest/v1/files/previews':                                                             'ok   ok   ok   ok   ok',
  'POST /rest/v1/files/upload-intent':                                                        'ok   ok   ok   ok   ok',

  // /rest/v1/job-roles
  'GET /rest/v1/job-roles':                                                                   'ok   ok   ok   ok   403',
  'POST /rest/v1/job-roles':                                                                  'ok   ok   ok   403  403',
  'POST /rest/v1/job-roles/:id/archive':                                                      'ok   ok   ok   403  403',
  'POST /rest/v1/job-roles/:id/restore':                                                      'ok   ok   ok   403  403',

  // /rest/v1/leadership
  'GET /rest/v1/leadership/capabilities':                                                     'ok   ok   ok   403  403',

  // /rest/v1/manager-workspaces
  'POST /rest/v1/manager-workspaces':                                                         'ok   ok   ok   403  403',
  'GET /rest/v1/manager-workspaces/me':                                                       'ok   ok   ok   403  403',
  'PATCH /rest/v1/manager-workspaces/me':                                                     'ok   ok   ok   403  403',
  'POST /rest/v1/manager-workspaces/me/complete-onboarding':                                  'ok   ok   ok   403  403',
  'POST /rest/v1/manager-workspaces/me/logo':                                                 'ok   ok   ok   403  403',
  'DELETE /rest/v1/manager-workspaces/me/logo':                                               'ok   ok   ok   403  403',
  'PATCH /rest/v1/manager-workspaces/me/subdomain':                                           'ok   ok   ok   403  403',
  'POST /rest/v1/manager-workspaces/subdomain/check':                                         'ok   ok   ok   403  403',
  'POST /rest/v1/manager-workspaces/subdomain/suggestions':                                   'ok   ok   ok   403  403',

  // /rest/v1/managers
  'GET /rest/v1/managers':                                                                    'ok   ok   403  403  403',
  'POST /rest/v1/managers':                                                                   'ok   ok   403  403  403',
  'GET /rest/v1/managers/:id':                                                                'ok   ok   403  403  403',
  'PATCH /rest/v1/managers/:id':                                                              'ok   ok   403  403  403',
  'DELETE /rest/v1/managers/:id':                                                             'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/archive':                                                       'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/cancel-invite':                                                 'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/deactivate':                                                    'ok   ok   403  403  403',
  'PATCH /rest/v1/managers/:id/email':                                                        'ok   ok   403  403  403',
  'GET /rest/v1/managers/:id/emails':                                                         'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/erase-personal-data':                                           'ok   ok   403  403  403',
  'GET /rest/v1/managers/:id/notes':                                                          'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/notes':                                                         'ok   ok   403  403  403',
  'PATCH /rest/v1/managers/:id/pending-email':                                                'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/reactivate':                                                    'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/resend-invite':                                                 'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/reset-password':                                                'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/restore':                                                       'ok   ok   403  403  403',
  'GET /rest/v1/managers/:id/timeline':                                                       'ok   ok   403  403  403',
  'GET /rest/v1/managers/:id/venues':                                                         'ok   ok   403  403  403',
  'POST /rest/v1/managers/:id/venues':                                                        'ok   ok   403  403  403',
  'DELETE /rest/v1/managers/:id/venues/:venueId':                                             'ok   ok   403  403  403',
  'POST /rest/v1/managers/bulk-email':                                                        'ok   ok   403  403  403',
  'POST /rest/v1/managers/initial-manager-invite':                                            'ok   ok   403  403  403',
  'POST /rest/v1/managers/initial-manager-invite/replace':                                    'ok   ok   403  403  403',
  'POST /rest/v1/managers/initial-manager-invite/resend':                                     'ok   ok   403  403  403',
  'POST /rest/v1/managers/initial-manager-invite/revoke':                                     'ok   ok   403  403  403',

  // /rest/v1/member-invitations
  'GET /rest/v1/member-invitations':                                                          'ok   ok   ok   403  403',
  'POST /rest/v1/member-invitations':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/member-invitations/:id/resend':                                              'ok   ok   ok   403  403',
  'POST /rest/v1/member-invitations/:id/revoke':                                              'ok   ok   ok   403  403',
  'GET /rest/v1/member-invitations/assignable-roles':                                         'ok   ok   ok   403  403',

  // /rest/v1/members
  'GET /rest/v1/members':                                                                     'ok   ok   ok   403  403',
  'POST /rest/v1/members/:userId/reinstate':                                                  'ok   ok   ok   403  403',
  'PATCH /rest/v1/members/:userId/role':                                                      'ok   ok   ok   403  403',
  'POST /rest/v1/members/:userId/suspend':                                                    'ok   ok   ok   403  403',

  // /rest/v1/navigation-layout
  'GET /rest/v1/navigation-layout':                                                           'ok   ok   ok   403  403',
  'PUT /rest/v1/navigation-layout':                                                           'ok   ok   ok   403  403',

  // /rest/v1/notifications
  'GET /rest/v1/notifications':                                                               'ok   ok   ok   ok   ok',
  'POST /rest/v1/notifications/:id/read':                                                     'ok   ok   ok   ok   ok',
  'POST /rest/v1/notifications/read-all':                                                     'ok   ok   ok   ok   ok',
  'GET /rest/v1/notifications/unread-count':                                                  'ok   ok   ok   ok   ok',

  // /rest/v1/offers
  'GET /rest/v1/offers':                                                                      'ok   ok   ok   ok   403',
  'POST /rest/v1/offers/:id/accept':                                                          '403  403  403  403  ok',
  'POST /rest/v1/offers/:id/confirm':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/offers/:id/decline':                                                         '403  403  403  403  ok',
  'POST /rest/v1/offers/:id/reject':                                                          'ok   ok   ok   403  403',
  'POST /rest/v1/offers/:id/withdraw':                                                        'ok   ok   ok   403  403',
  'GET /rest/v1/offers/batches/:batchId':                                                     'ok   ok   ok   403  403',
  'POST /rest/v1/offers/batches/:batchId/confirm-all':                                        'ok   ok   ok   403  403',
  'GET /rest/v1/offers/mine':                                                                 '403  403  403  403  ok',

  // /rest/v1/org-admin
  'POST /rest/v1/org-admin/venue-managers':                                                   'ok   ok   403  403  403',
  'GET /rest/v1/org-admin/venue-managers/:id/assignable-staff':                               'ok   ok   403  403  403',
  'GET /rest/v1/org-admin/venue-managers/:id/staff':                                          'ok   ok   403  403  403',
  'POST /rest/v1/org-admin/venue-managers/:id/staff':                                         'ok   ok   403  403  403',
  'DELETE /rest/v1/org-admin/venue-managers/:id/staff/:staffId':                              'ok   ok   403  403  403',

  // /rest/v1/payroll
  'GET /rest/v1/payroll/calendar':                                                            'ok   ok   ok   403  403',
  'POST /rest/v1/payroll/calendar/import':                                                    'ok   ok   ok   403  403',
  'GET /rest/v1/payroll/me/payslips':                                                         '403  403  403  403  ok',
  'GET /rest/v1/payroll/me/statements':                                                       '403  403  403  403  ok',
  'GET /rest/v1/payroll/period':                                                              'ok   ok   ok   403  403',
  'GET /rest/v1/payroll/records':                                                             'ok   ok   ok   403  403',
  'POST /rest/v1/payroll/records/:id/approve':                                                '403  403  ok   403  403',
  'POST /rest/v1/payroll/records/:id/reject':                                                 '403  403  ok   403  403',
  'POST /rest/v1/payroll/records/:id/statement/retry':                                        '403  403  ok   403  403',
  'POST /rest/v1/payroll/records/bulk-approve':                                               '403  403  ok   403  403',
  'GET /rest/v1/payroll/runs':                                                                'ok   ok   ok   403  403',
  'GET /rest/v1/payroll/runs/:runId':                                                         'ok   ok   ok   403  403',
  'GET /rest/v1/payroll/runs/:runId/export':                                                  'ok   ok   ok   403  403',
  'POST /rest/v1/payroll/runs/:runId/finalise':                                               '403  403  ok   403  403',
  'POST /rest/v1/payroll/runs/:runId/payslips/:staffProfileId/document':                      'ok   ok   ok   403  403',
  'POST /rest/v1/payroll/runs/:runId/payslips/:staffProfileId/mark-paid':                     '403  403  ok   403  403',
  'PUT /rest/v1/payroll/runs/:runId/payslips/:staffProfileId/net':                            'ok   ok   ok   403  403',
  'POST /rest/v1/payroll/runs/prepare':                                                       'ok   ok   ok   403  403',

  // /rest/v1/profile
  'GET /rest/v1/profile':                                                                     'ok   ok   ok   ok   ok',
  'PATCH /rest/v1/profile':                                                                   'ok   ok   ok   ok   ok',
  'POST /rest/v1/profile/avatar':                                                             'ok   ok   ok   ok   ok',
  'DELETE /rest/v1/profile/avatar':                                                           'ok   ok   ok   ok   ok',
  'GET /rest/v1/profile/notification-preferences':                                            'ok   ok   ok   ok   ok',
  'PATCH /rest/v1/profile/notification-preferences':                                          'ok   ok   ok   ok   ok',
  'GET /rest/v1/profile/preferences':                                                         'ok   ok   ok   ok   ok',
  'PATCH /rest/v1/profile/preferences':                                                       'ok   ok   ok   ok   ok',
  'GET /rest/v1/profile/sessions':                                                            'ok   ok   ok   ok   ok',
  'DELETE /rest/v1/profile/sessions':                                                         'ok   ok   ok   ok   ok',
  'DELETE /rest/v1/profile/sessions/:familyId':                                               'ok   ok   ok   ok   ok',
  'POST /rest/v1/profile/sessions/logout-all':                                                'ok   ok   ok   ok   ok',

  // /rest/v1/push
  'POST /rest/v1/push/devices':                                                               'ok   ok   ok   ok   ok',
  'POST /rest/v1/push/devices/:deviceId/deactivate':                                          'ok   ok   ok   ok   ok',
  'POST /rest/v1/push/devices/deactivate-all':                                                'ok   ok   ok   ok   ok',

  // /rest/v1/realtime
  'GET /rest/v1/realtime/stream':                                                             'ok   ok   ok   ok   ok',

  // /rest/v1/replacement-requests
  'GET /rest/v1/replacement-requests':                                                        'ok   ok   ok   403  403',
  'GET /rest/v1/replacement-requests/:id':                                                    'ok   ok   ok   403  403',
  'POST /rest/v1/replacement-requests/:id/approve':                                           'ok   ok   ok   403  403',
  'POST /rest/v1/replacement-requests/:id/reject':                                            'ok   ok   ok   403  403',

  // /rest/v1/roles
  'GET /rest/v1/roles':                                                                       'ok   ok   ok   403  403',
  'POST /rest/v1/roles':                                                                      'ok   ok   ok   403  403',
  'GET /rest/v1/roles/:id':                                                                   'ok   ok   ok   403  403',
  'PUT /rest/v1/roles/:id':                                                                   'ok   ok   ok   403  403',
  'DELETE /rest/v1/roles/:id':                                                                'ok   ok   ok   403  403',
  'GET /rest/v1/roles/:id/definition':                                                        'ok   ok   ok   403  403',
  'GET /rest/v1/roles/object-metadata':                                                       'ok   ok   ok   403  403',
  'GET /rest/v1/roles/permissions':                                                           'ok   ok   ok   403  403',

  // /rest/v1/search
  'GET /rest/v1/search':                                                                      'ok   ok   ok   403  403',

  // /rest/v1/shifts
  'GET /rest/v1/shifts':                                                                      'ok   ok   ok   ok   403',
  'POST /rest/v1/shifts':                                                                     'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/:id':                                                                  'ok   ok   ok   ok   403',
  'POST /rest/v1/shifts/:id/approve':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/archive':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/cancel':                                                          'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/decline':                                                         'ok   ok   ok   403  403',
  'PATCH /rest/v1/shifts/:id/draft':                                                          'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/:id/pipeline':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/pipeline/offers/:offerId/cancel':                                 'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/pipeline/replacements':                                           'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/publish':                                                         'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/:id/requested-staff':                                                  'ok   ok   ok   403  403',
  'PUT /rest/v1/shifts/:id/requested-staff':                                                  'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/requested-staff/:staffProfileId':                                 'ok   ok   ok   403  403',
  'DELETE /rest/v1/shifts/:id/requested-staff/:staffProfileId':                               'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/restore':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:id/rotate-qr':                                                       'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/:id/selectable-staff':                                                 'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:shiftId/offers':                                                     'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/:shiftId/offers/bulk':                                                'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/:shiftId/replacement-context':                                         'ok   ok   ok   403  403',
  'POST /rest/v1/shifts/request':                                                             'ok   ok   ok   ok   403',
  'GET /rest/v1/shifts/requests':                                                             'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/requests/pending':                                                     'ok   ok   ok   403  403',
  'GET /rest/v1/shifts/sent':                                                                 '403  403  403  ok   403', // SchedulingService: Venue Managers only, 403 "Venue manager required."
  'GET /rest/v1/shifts/sent/:id':                                                             'ok   ok   ok   ok   403',
  'POST /rest/v1/shifts/with-offers':                                                         'ok   ok   ok   403  403',

  // /rest/v1/staff
  'GET /rest/v1/staff':                                                                       'ok   ok   ok   403  403',
  'POST /rest/v1/staff':                                                                      'ok   ok   ok   403  403',
  'GET /rest/v1/staff/:id':                                                                   'ok   ok   ok   ok   403',
  'PATCH /rest/v1/staff/:id':                                                                 'ok   ok   ok   403  403',
  'DELETE /rest/v1/staff/:id':                                                                'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/archive':                                                          'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/avatar':                                                           'ok   ok   ok   403  403',
  'DELETE /rest/v1/staff/:id/avatar':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/cancel-invite':                                                    'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/deactivate':                                                       'ok   ok   ok   403  403',
  'PATCH /rest/v1/staff/:id/email':                                                           'ok   ok   ok   403  403',
  'GET /rest/v1/staff/:id/emails':                                                            'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/erase-personal-data':                                              'ok   ok   ok   403  403',
  'GET /rest/v1/staff/:id/notes':                                                             'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/notes':                                                            'ok   ok   ok   403  403',
  'PATCH /rest/v1/staff/:id/pending-email':                                                   'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/reactivate':                                                       'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/resend-invite':                                                    'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/reset-password':                                                   'ok   ok   ok   403  403',
  'POST /rest/v1/staff/:id/restore':                                                          'ok   ok   ok   403  403',
  'GET /rest/v1/staff/:id/timeline':                                                          'ok   ok   ok   403  403',
  'GET /rest/v1/staff/:staffProfileId/reviews':                                               'ok   ok   ok   403  403',
  'GET /rest/v1/staff/:staffProfileId/reviews/:reviewId':                                     'ok   ok   ok   403  403',
  'POST /rest/v1/staff/bulk-email':                                                           'ok   ok   ok   403  403',
  'GET /rest/v1/staff/venue-directory':                                                       '404  404  404  ok   403', // StaffService: the venue directory exists only for a Venue Manager, 404 "Directory not found."
  'GET /rest/v1/staff/venue-directory/:staffId':                                              'ok   ok   ok   ok   403', // guard chain only (staff.view); StaffService joins on the caller's OWN venue manager profile, so any non-Venue-Manager gets 404 for every id
  'PATCH /rest/v1/staff/venue-directory/:staffId/tags':                                       'ok   ok   ok   ok   403', // guard chain only; the UPDATE is scoped to the caller's OWN venue manager profile (404 for anyone else)

  // /rest/v1/timeline
  'GET /rest/v1/timeline/attendance/:id':                                                     'ok   ok   ok   403  403',
  'GET /rest/v1/timeline/offers/:id':                                                         'ok   ok   ok   403  403',
  'GET /rest/v1/timeline/payroll-records/:id':                                                'ok   ok   ok   403  403',
  'GET /rest/v1/timeline/shifts/:id':                                                         'ok   ok   ok   403  403',
  'GET /rest/v1/timeline/staff/:id':                                                          'ok   ok   ok   403  403',

  // /rest/v1/venue-managers
  'GET /rest/v1/venue-managers':                                                              '403  403  ok   403  403',
  'POST /rest/v1/venue-managers':                                                             '403  403  ok   403  403',
  'GET /rest/v1/venue-managers/:id':                                                          '403  403  ok   403  403',
  'PATCH /rest/v1/venue-managers/:id':                                                        '403  403  ok   403  403',
  'DELETE /rest/v1/venue-managers/:id':                                                       '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/avatar':                                                  '403  403  ok   403  403',
  'DELETE /rest/v1/venue-managers/:id/avatar':                                                '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/cancel-invite':                                           '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/deactivate':                                              '403  403  ok   403  403',
  'PATCH /rest/v1/venue-managers/:id/email':                                                  '403  403  ok   403  403',
  'GET /rest/v1/venue-managers/:id/emails':                                                   '403  403  ok   403  403',
  'GET /rest/v1/venue-managers/:id/notes':                                                    '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/notes':                                                   '403  403  ok   403  403',
  'PATCH /rest/v1/venue-managers/:id/pending-email':                                          '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/reactivate':                                              '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/resend-invite':                                           '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/reset-password':                                          '403  403  ok   403  403',
  'GET /rest/v1/venue-managers/:id/staff':                                                    '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/staff':                                                   '403  403  ok   403  403',
  'DELETE /rest/v1/venue-managers/:id/staff/:staffId':                                        '403  403  ok   403  403',
  'GET /rest/v1/venue-managers/:id/timeline':                                                 '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/:id/venues':                                                  '403  403  ok   403  403',
  'POST /rest/v1/venue-managers/bulk-email':                                                  '403  403  ok   403  403',

  // /rest/v1/venues
  'GET /rest/v1/venues':                                                                      'ok   ok   ok   ok   403',
  'POST /rest/v1/venues':                                                                     'ok   ok   ok   403  403',
  'GET /rest/v1/venues/:id':                                                                  'ok   ok   ok   ok   403',
  'PATCH /rest/v1/venues/:id':                                                                'ok   ok   ok   403  403',
  'POST /rest/v1/venues/:id/archive':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/venues/:id/photo':                                                           'ok   ok   ok   403  403',
  'DELETE /rest/v1/venues/:id/photo':                                                         'ok   ok   ok   403  403',
  'POST /rest/v1/venues/:id/restore':                                                         'ok   ok   ok   403  403',
  'GET /rest/v1/venues/:id/role-rates':                                                       'ok   ok   ok   403  403',
  'POST /rest/v1/venues/:id/role-rates':                                                      'ok   ok   ok   403  403',
  'PATCH /rest/v1/venues/:id/role-rates/:rateId':                                             'ok   ok   ok   403  403',
  'DELETE /rest/v1/venues/:id/role-rates/:rateId':                                            'ok   ok   ok   403  403',

  // /rest/v1/workspace
  'GET /rest/v1/workspace':                                                                   'ok   ok   ok   403  403',
  'GET /rest/v1/workspace/security':                                                          'ok   ok   ok   403  403',
};
