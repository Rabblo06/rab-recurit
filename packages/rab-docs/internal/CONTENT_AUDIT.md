# Crewflow documentation — content audit

Source-backed inventory of every feature the documentation covers: its implementation status, the code that implements it, the evidence behind the status, and the pages that document it.

- **Audited:** 2026-10-13, against `main` at `1993562e` (branch `docs/rab-docs-site`).
- **Method:** read-only audits of `rab-server`, `rab-worker`, `rab-shared`, `rab-emails`, `rab-front` and `rab-mobile`, followed by targeted spot checks of every claim that affects pay, permissions or attendance. Spot checks are listed under each section.
- **Paths:** `S` = `packages/rab-server/src`, `W` = `packages/rab-worker/src`, `SH` = `packages/rab-shared/src`, `F` = `packages/rab-front/src`, `M` = `packages/rab-mobile/lib`.

## Status key

| Status | Meaning | Allowed in user guides? |
| --- | --- | --- |
| **Verified** | Implemented, and covered by automated tests or verified in a running app | Yes |
| **Implemented** | Code exists and is reachable from the UI; not independently re-verified for this audit | Yes, with care |
| **In development** | Partly built, behind a flag, or not verified end to end | Only on *Product status* |
| **Planned** | Designed or stubbed; no working path | Only on *Product status* |
| **Not supported** | No implementation | Stated explicitly where users would expect it |

## Accounts and authentication

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| Email invitation and activation (24 h, 3 sends, 7-day clean-up) | Verified | `S/engine/core-modules/auth/services/account-invite.service.ts:8-10`, `account-lifecycle.service.ts`, `F/features/auth/ActivateAccount.tsx` | `account-invite-abuse-cases`, `account-lifecycle-abuse-cases` integration suites | account/accepting-an-invitation, account/members-and-invitations, staff/account-states |
| Password sign-in (web) | Verified | `S/.../auth/services/auth.service.ts:146`, `F/features/auth/Login.tsx` | Auth integration suites; live local sign-in (handoff 2026-10-11) | account/signing-in |
| Password sign-in (mobile) + `X-Client-Platform: mobile` token body | Verified | `M/core/auth/auth_provider.dart:239`, `M/core/api/api_client.dart` | Flutter auth tests; mobile capture this audit | mobile/first-sign-in |
| Uniform login responses, argon2id (m=19456,t=2,p=1) | Verified | `password-hashing.service.ts:11-15` | Auth suites | security/authentication-and-sessions, developers/authentication-flow |
| Lockout 10 failures / 15 min → 429 (900 s) | Implemented | `auth.service.ts:27-28,159-171` | Code read | account/signing-in |
| Forgot / reset password (1 h token, revokes sessions) | Verified | `auth.service.ts:668-796`, `F/features/auth/ForgotPassword.tsx`, `ResetPassword.tsx` | Auth suites | account/password-reset |
| Google and Microsoft OIDC (invite-only, verified email, PKCE) | Implemented | `oidc-login.service.ts`, `google-auth.controller.ts`, `microsoft-auth.controller.ts`, `organisation-auth-providers.service.ts` | Code read; disabled by default (`AUTH_*_ENABLED=false`) | account/google-and-microsoft-sign-in |
| Web session cookies, 24 h / 30 min; mobile 90 d / 7 d | Verified | `S/.../auth/session-policy.ts`, `refresh-cookie.constants.ts`, `web-session-cookie.constants.ts` | `session-auth-correctness`, P1B suites | account/sessions-and-devices, security/authentication-and-sessions |
| Refresh rotation + reuse detection | Verified | `S/.../token/services/refresh-token.service.ts:194-229` | Session suites | security/authentication-and-sessions |
| Active sessions list, revoke, sign out others/everywhere | Implemented | `S/modules/identity/controllers/profile.controller.ts`, `F/features/settings/**/DevicesList.tsx` | Code read. Note: 7 pre-existing `DevicesList` spec failures recorded in the handoff | account/sessions-and-devices |
| CSRF Origin check for cookie requests | Verified | `S/engine/guards/jwt-auth.guard.ts:219-226`, `cookie-csrf.util.ts` | `environment.service.spec.ts` (12 cases) | security/authentication-and-sessions |
| Biometric unlock on mobile, 90-day password re-auth | Implemented (device-side only) | `M/core/auth/*`, `M/core/auth/biometric_config.dart` | Flutter tests; no server component | mobile/biometric-sign-in |
| Step-up password for deletion and admin actions | Verified | `step-up-reauth.service.ts` | `user-deletion-abuse-cases` | security/authentication-and-sessions |
| Multi-factor authentication | Not supported | — | Columns only; no policy | security/authentication-and-sessions |

## Organisation, roles and workspaces

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| Roles: CEO, manager, venue manager, staff; permission matrix | Verified | `S/modules/manager/services/manager.service.ts:44-145`, `S/modules/staff/services/staff.service.ts:68-69`, `SH/constants/permission-flags.ts` | Role abuse-case suites | getting-started/user-roles, account/roles-and-permissions |
| Application targets (staff → staff_app, VM → venue_manager_app) | Verified | `S/engine/core-modules/auth/application-access.ts` | Root-gate isolation tests (mobile), auth suites | getting-started/user-roles, developers/authentication-flow |
| Platform admin independent of roles | Verified | `core.platform_admin`, `manager.service.ts:229-236` | `bootstrap-cli-platform-admin` | getting-started/user-roles |
| Organisation creation + CEO invitation (platform admin) | Verified | `S/modules/manager/services/organisation-onboarding.service.ts`, `F/features/settings/**/OrganisationsTab.tsx` | `organisation-onboarding.integration.spec.ts` (9/9) | account/organisation-administration, getting-started/quickstart-administrator |
| Initial Manager invitation, resend/revoke/replace | Verified | same service; `manager.controller.ts:144-171` | `initial-manager-invitation` (10/10), `initial-manager-replacement` | account/manager-accounts, account/organisation-administration |
| Organisation suspension | Verified (API only) | `organisation-suspension.service.ts`, `admin-panel.controller.ts` | `organisation-suspension.integration.spec.ts` (12/12). **No web UI button** — spot-checked: no `/suspend` call in `F` | account/organisation-administration, security/audit-and-data-protection |
| Admin Panel SMTP config | Implemented, **not used for delivery** | `admin-panel.controller.ts`; driver `email-driver.factory.ts:21-47` reads env only | Spot check this audit | account/organisation-administration (warning), developers/email-and-notifications |
| Members page: Team / Invite / Roles | Implemented | `F/features/settings/members/MembersPage.tsx:40-66` | `MembersPage.spec.tsx` | account/members-and-invitations |
| Custom role creation | Implemented, effectively unavailable | `role.controller.ts` (`role.manage`) | No standard role holds `role.manage` | account/roles-and-permissions |
| Manager workspace creation, subdomain check, onboarding | Verified | `S/modules/manager-workspace/services/manager-workspace.service.ts`, `F/features/onboarding/*` | `manager-workspace-onboarding`, onboarding specs (54+), live verification | workspaces/creating-a-workspace |
| CEO own-workspace operational home | Verified | `manager-workspace.service.ts:358-382` | `ceo-own-workspace-operational-home.integration.spec.ts` (5) | getting-started/organisations-and-workspaces, developers/workspace-isolation |
| One active workspace membership per user; no switching | Verified | migration `1786675000000-WorkspaceMembershipCutover.ts`, `workspace-membership.service.ts` | Membership abuse cases | workspaces/access-changes |
| Workspace isolation via RLS (`rab.*` GUCs) | Verified | `S/engine/core-modules/tenant/tenant-context.service.ts:120-134`, migration `1786665700000-TenantSessionContext.ts` | `manager-profile-isolation`, `check-rls-coverage` | workspaces/overview, security/data-isolation, developers/workspace-isolation |
| Per-workspace schemas (HWS) | In development | `S/.../tenant/schema-resolver.service.ts`, `W/workspace-provisioner.main.ts` | Flag `HWS_RUNTIME_ENABLED` default false | getting-started/product-status, developers/workspace-isolation |
| Workspace-branded sign-in by hostname | Planned | — | Handoff: audited, not built | getting-started/product-status, workspaces/workspace-settings |

## Staff and venues

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| Staff directory, filters, columns | Implemented | `F/features/users/Users.tsx` | Captured live with fixtures | staff/overview |
| Four-step staff creation; only email/first/last required server-side | Verified | `F/features/users/CreateUserModal.tsx`, `S/modules/staff/dto/create-staff.dto.ts` | Spot check; staff suites | staff/adding-staff |
| Staff reference `STAFF n` | Implemented | `staff.service.ts:614-626` | Code read | staff/overview |
| Deactivate = employment inactive + user suspended; reactivate | Verified | `staff.service.ts:834-870` | Spot check this audit | staff/deactivating-and-deleting |
| Delete blocked with history | Implemented | `manager.service.ts`, `staff.service.ts` | `user-deletion-abuse-cases` | staff/deactivating-and-deleting |
| Bulk email | Implemented | `F/features/users/BulkEmailPanel.tsx`, `POST /staff/bulk-email` | Code read | staff/bulk-email |
| Bulk deactivate/delete/export | Not supported | — | — | staff/deactivating-and-deleting |
| Venues CRUD, archive (one-way) | Implemented | `S/modules/venue/*`, `F/features/venues/*`, `SH/state` venue transitions | Venue suites | venues/overview |
| Geofence (opt-in, radius ≥ 50 m, accuracy ≤ 100 m) | Verified | `F/features/venues/venueGeofence.ts`, `S/modules/attendance/services/attendance.service.ts:171-192` | Attendance suites; spot check | venues/geofence-and-breaks |
| Role pay rates; rate resolution and snapshot | Verified | `scheduling.service.ts:305-333`, `offer.service.ts:339` | Scheduling/offer suites | venues/pay-rates, payroll/pay-calculation |
| Venue "Paid" break flag | **Stored but unused** | `venue.entity.ts:56`; no reader outside DTO/entity | Spot check: grep this audit | venues/geofence-and-breaks (warning), payroll/pay-calculation |
| Venue manager team list ("Users") | Implemented | `M/features/venue_manager/venue_staff_directory.dart`, `POST /staff/venue-directory/team/:id` | Code read; capture | venues/venue-managers, mobile/venue-manager-staff |
| Favourites | Not supported | — | — | venues/venue-managers |

## Shifts and offers

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| Create shift + offers in one step (`/shifts/with-offers`) | Verified | `F/features/scheduling/ShiftDrawers.tsx`, `S/modules/offer/services/offer.service.ts:434-697` | `qa_shift_workflow` e2e, offer suites | shifts/creating-shifts |
| Send more offers / bulk (≤ 100) / batches | Verified | offer DTOs, `offer.service.ts` | Offer suites | shifts/sending-offers |
| Offer state machine | Verified | `SH/state/offer-transitions.ts` | `rab-shared` specs, `scheduling-offer-abuse-cases` | shifts/overview, shifts/status-reference |
| Shift state machine | Verified | `SH/state/shift-transitions.ts` | Same | shifts/overview, shifts/status-reference |
| Atomic accept (pending and not expired) | Verified | `offer.service.ts:841-847` | Offer suites | shifts/staff-responses |
| Decline with no reason (mobile) | Implemented | `M/features/offers/schedule_offer_detail_screen.dart` | Mobile audit | shifts/staff-responses, mobile/offers |
| Confirm / reject / confirm-all per batch | Verified | `offer.controller.ts:113-118`, `offer.service.ts:1062` | Offer suites | shifts/confirming-offers |
| Auto-confirm on accept for venue requests | Verified | `offer.service.ts:820-828,915-925` | Suites | shifts/confirming-offers, shifts/venue-requests |
| Auto-confirm after 60 min manager inaction | Verified | `W/queues/rab-offers/offer-expiry.job.ts:200-310` | Worker suites; spot check (`'Shift auto-confirmed'`) | shifts/offer-expiry |
| Offer expiry 48 h default, checked every 60 s | Verified | `offer.service.ts:357`, worker loop | Spot check | shifts/offer-expiry |
| Replacement suggestions (≤ 5, never auto-send) | Implemented (no UI list) | `W/queues/rab-offers/replacement-staff.job.ts` | Spot check: no `replacement-requests` call in `F` | shifts/sending-offers |
| Replacement offers from live board | Implemented | `F/features/scheduling/StaffSelectionPage.tsx:60`, `venue-offer-pipeline.service.ts:229-259` | Code read | shifts/live-staffing-pipeline |
| Venue requests: approve / decline / adjust staff | Verified | `ShiftApprovalDrawer.tsx`, `scheduling.controller.ts` | Venue pipeline suites; handoff live verification | shifts/venue-requests |
| Live staffing Kanban (7 stages, cancel ≤ 15 min before) | Verified | `S/modules/offer/**/venue-offer-presentation.ts`, `VenueOfferPipeline.tsx` | Spot check; pipeline suites | shifts/live-staffing-pipeline |
| Shift cancellation + follow-up | Verified | `scheduling.service.ts:398-435`, `W/queues/rab-shifts/shift-cancellation-followup.job.ts` | Worker suites | shifts/cancelling-shifts |
| Calendar month view | Implemented | `F/features/scheduling/Calendar.tsx` | Capture | calendar/overview |
| Calendar day/week, filters, drag-to-reschedule, bulk scheduling | Not supported | — | — | calendar/overview, getting-started/product-status |

## Attendance, timesheets and pay

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| Clock window (−15 min / +120 min) | Verified | `attendance.service.ts:148-158` | `attendance-lifecycle-42` integration (42/42) | attendance/overview, attendance/clock-in-and-out |
| Signed shift QR (one per shift) | Verified | `qr-token.service.ts:32-75` | Same; QR not physically printed/scanned in QA | attendance/clock-in-and-out |
| Geofence exit auto clock-out (app open only) | Implemented | `attendance.service.ts:327-352`, mobile watcher | Simulated GPS only | attendance/clock-in-and-out, mobile/clock-in-and-out |
| Late (10 min), no-show (30 min), missing clock-out (30 min) | Verified | `late-clock-in.ts`, `shift-monitor.job.ts`, `attendance-monitor.job.ts:41` | Worker suites | attendance/late-and-missing-clock-outs |
| Break start/stop | Not supported | No endpoint despite `on_break` state | — | attendance/late-and-missing-clock-outs |
| Worked minutes (`duration.ts`) and pay | Verified | `SH/utils/duration.ts`, `attendance.service.ts:379-390` | `rab-shared` specs | payroll/pay-calculation |
| Corrections with reason (≥ 10 chars), VM scoped | Verified | `attendance.service.ts:596-700`, `M/features/venue_manager/attendance_correction_sheet.dart` | Attendance suites | attendance/timesheet-review, mobile/venue-manager-reports |
| Finalise & send | Verified | `shift-report.service.ts:131-185` | Lifecycle suite | attendance/timesheet-review |
| Signature capture | Not supported | Final PDF text only (`final-timesheet.html.ts:82`) | Spot check | attendance/timesheet-review |
| Roster and final timesheet PDFs | Verified | `W/queues/rab-reports/*` | Lifecycle suite; email via real provider blocked in QA | attendance/timesheet-documents |
| CSV / spreadsheet export | Not supported | — | — | attendance/timesheet-documents, payroll/reviewing-payroll |
| Payroll page (from `/attendance`) | Implemented | `F/features/payroll/Payroll.tsx` | Capture | payroll/reviewing-payroll |
| Payroll approval, paid status, payslips, payment processing | Planned / not supported | Flags and transition tables only (`SH/state/payroll-transitions.ts`) | Grep: no server usage | payroll/overview, getting-started/product-status |
| Audit log (append-only) | Verified | `S/engine/core-modules/audit/*`, migrations `1786666200000`, `1786686000000` | `audit-log-abuse-cases` | payroll/audit-log, security/audit-and-data-protection |

## Notifications and automation

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| In-app notifications (web bell, mobile inbox) | Implemented | `S/modules/notification/*`, `F/features/notifications/NotificationBell.tsx`, `M/features/notifications/*` | Captures | notifications/overview |
| Email outbox + drivers | Verified | `S/engine/core-modules/email/*` | Email suites; real provider delivery blocked in QA | developers/email-and-notifications |
| Notification preferences (six offer events) | Implemented | `F/features/settings/account/NotificationsCard.tsx:13-18` | Spot check | account/profile-and-preferences |
| Reminders 24 h/2 h/30 min, clock-in window open | Verified | `W/queues/rab-shifts/shift-monitor.job.ts` | Worker suites | notifications/automation |
| Worker-event idempotency | Verified | `W/core/database/worker-event.ts` | `worker-operations-abuse-cases` | developers/background-jobs |
| Push (FCM/APNs) | In development | `S/engine/core-modules/push/*`, `M/core/push/push_registration_service.dart` | No `google-services.json`; `PUSH_ENABLED=false` | getting-started/product-status, notifications/overview |
| Real-time SSE | In development (built, off) | `S/engine/core-modules/realtime/*` | Flag default false; gateway returns 204 | developers/email-and-notifications |

## Mobile

| Feature | Status | Source | Evidence | Pages |
| --- | --- | --- | --- | --- |
| Staff tabs Home/Calendar/History/Profile | Verified | `M/navigation/app_shell.dart`, `moving_tab_bar.dart` | Goldens, capture | mobile/overview |
| Offers list, Job Details, accept/decline | Verified | `M/features/offers/*` | Widget tests, capture | mobile/offers |
| Clock screen states | Verified | `M/features/home/schedule_clock_screen.dart` | Goldens `test/goldens/clock-*.png` | mobile/clock-in-and-out |
| Venue manager Send Shift, Sent Shifts, Event Details, Reports | Verified | `M/features/venue_manager/*` | Widget tests, capture | mobile/venue-manager-* |
| My availability, Payslip | Planned (disabled in UI) | `M/core/widgets/schedule_home_components.dart` | Mobile audit | mobile/home |
| iOS app | Not supported | No `ios/` folder | — | getting-started/product-status |

## Known product defects found during the audit (not fixed by documentation work)

| Finding | Location | Documentation handling |
| --- | --- | --- |
| `breakPaid` stored but never applied to pay | `S/modules/venue/entities/venue.entity.ts:56` | Warning on venue and pay pages |
| Admin Panel SMTP settings unused by the email driver | `email-driver.factory.ts:21-47` | Warning on administration page |
| `MANAGER_CONFIRMATION_TIMEOUT_MINUTES` comment says auto-reject; job auto-confirms | `environment-variables.ts:558-579` vs `offer-expiry.job.ts` | Docs follow the job's behaviour |
| `/users/:id` legacy page calls a non-existent `/users/:id` endpoint | `F/features/users/UserProfile.tsx` | Not documented |
| Orphan settings routes (workspace security/domains/roles/team) | `F/App.tsx`, `SettingsSidebar.tsx` | Not documented as navigable |
| Venue manager "Scheduled" row shows `?` between times | `M/features/venue_manager/venue_manager_screens.dart:1287` | Not documented |
| Many permission flags defined but unenforced (payroll.*, schedule.bulk, …) | `SH/constants/permission-flags.ts` | Not presented as features |
| Mobile notification times shown in UTC (no `.toLocal()`) | `M/features/notifications/notifications_screen.dart` | Not documented |
| Mobile realtime and push services never started; app relies on 30 s polling | `M/core/realtime/*`, `M/core/push/*` | Docs describe polling and pull-to-refresh only |
| "Set up Biometric Login" sheet can render blank on slow devices | `M/features/auth_flow/auth_flow_shell.dart` (`_transitionTo`) | Not documented |
| Staff Home "N confirmed" includes past shifts | `M/core/widgets/schedule_home_components.dart` | Docs avoid quoting the count |
| Final timesheet PDF titled "RAB Recruitment" with raw UTC timestamps | `S/modules/attendance/templates/final-timesheet.html.ts` | Not documented |
