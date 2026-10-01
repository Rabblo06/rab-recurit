# RAB Project Handoff

## 1. Project overview

RAB is a workforce recruitment/scheduling platform. Flutter serves Staff and Venue Manager; React serves the web console/portal. NestJS owns business rules. Read `../CLAUDE.md` for working agreements and `../rab-workforce-architecture.md` for the domain architecture.

## 2. Repository map

- `packages/rab-mobile/lib`: Flutter `core`, feature folders and `navigation`; tests under `test`.
- `packages/rab-front`: web client.
- `packages/rab-server/src`: `engine` platform services, `modules` staffing domain, versioned database migrations. Background jobs live in the separate `packages/rab-worker` package, not here.
- `packages/rab-docker`: local infrastructure; shared packages contain domain contracts/utilities.
- Local QA evidence was intentionally removed from source control.

## 3. Non-negotiable architecture

One backend codebase, API and Worker processes; no duplicate business rules. `engine` must not import `modules`. Use migrations, never TypeORM synchronize. Preserve existing dirty work; this repository currently contains substantial uncommitted UI, storage and security changes.

## 4. Security model

Verified session supplies organisation/workspace/user context. Never accept client identity as authority. Guards, service checks, scoped queries and RLS all apply. Runtime `rab_app` has no RLS bypass; pre-auth exemptions are documented in the RLS coverage tool. Fail closed. Out-of-scope records return 404. Permission checks are server-derived. Audit history is append-only. See `security/SECURITY-TEST-MATRIX.md` and `../CLAUDE.md`.

## 5. Roles / application access

Staff and Venue Manager use distinct authorised app roots/destinations. Internal Manager access follows existing application-target rules; never broaden access to repair UI. Hidden controls are supplementary to backend checks. Root-gate isolation and login-navigation tests must remain green.

## 6. Mobile design system

Preserve off-white backgrounds, approved pastel cards, black primary actions and restrained shadows. Reuse `ScheduleTokens`, shared geometry and accessible touch targets. Status colour is independent of shift identity colour. Avoid new per-screen palettes or copied components.

## 7. Shared components

`MovingTabBar` supplies shared floating navigation geometry with fixed icon centres. `AppShell` owns Staff navigation; Venue Manager composes the shared bar. `ScheduleRecordCard`, `SchedulePanel`, `ScheduleMessageCard`, shared button/sheet primitives in `schedule_feedback.dart`, `ScheduleCalendar`, and avatar/round-icon primitives form the reusable UI. Inspect callers before creating equivalents.

## 8. Shift colour identity rule

Use `ShiftVisualStyle.forShift(shiftId)` for the underlying Shift entity. Offer `id` identifies an offer, Attendance `id` identifies attendance; use their `shiftId`. `VenueEvent.id` is the Shift id and its `shiftId` getter aliases it. Reports already carry `shiftId`. Never hash titles, offer/assignment ids, dates, list index, or runtime `hashCode`.

Shift colour is a UI identity attribute: same shift retains the same colour across all surfaces. Different shifts are distributed across the approved palette where possible. Colour is not derived from screen index and does not change with list reordering.

`ShiftColourRegistry` is the single process-lifetime mapping behind `ShiftVisualStyle.forShift`. The bounded UTF-16 polynomial hash (multiply by 31, modulo 2147483647) supplies a preferred slot only. Group registration reserves known assignments, allocates least-used nearby colours, breaks ties by probing from the preferred slot, and avoids the preceding colour when alternatives exist. The fixed palette is lavender/yellow/peach/mint/blue from `ScheduleTokens`. Offers/VM providers register complete groups before rendering; the shared deck and History also register their groups. Never reassign known IDs to repair a later filtered-list collision.

Persistence decision: in-memory app-session only, as permitted by the colour-distribution request. Rebuilds, navigation, refresh, logout/login and role switches in the same process retain assignments. Cold restart creates a new registry; identical discovery order repeats deterministically, but different discovery order can produce different assignments. There is no disk cache, backend column, cross-device colour promise or authorisation meaning. Immutable known assignments can collide when previously separate groups later merge; identity takes priority. Status colours remain separate.

## 9. Attendance / QR / geofence

Server validates assignment, time window, signed QR/version, geofence and attendance state. UI timers and eligibility are presentation only. Completion follows authoritative server reconciliation, not a local tap. Preserve duplicate-action locks and permission/error handling. See `attendance/lifecycle-and-release-checklist.md`. Never manipulate stale/unknown attendance for QA; use isolated disposable fixtures and document cleanup.

## 10. API + Worker architecture

Read `architecture/api-and-worker.md`. Clock mutations are synchronous API actions. Email, PDF/report rendering and scheduled work run in Worker. Both share PostgreSQL/Redis and domain services; job payloads do not grant authority. Worker reloads records under tenant context.

## 11. Storage architecture

Current working tree contains `FileService`, access registry and stored-file metadata, with LOCAL/S3 drivers selected by `StorageDriverFactory`. API and Worker must share storage configuration. Relevant variable names: `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Never include values here. Keep storage access checks, outage handling and worker idempotency tests intact.

## 12. Important workflows

Upcoming card â†’ Details uses `pastelDetailRoute`, a custom shared-surface `PageRouteBuilder`, not Hero: 500 ms forward/reverse, captured rectangle/style, staged content reveal. Source remains until destination first frame; whole deck then hides. Restore on animation dismissal before overlay removal and keep input locked until route completion. Preserve early-Back cancellation and reduced-motion behavior. Local QA evidence was intentionally removed from source control.

## 13. Tests / verification commands

From `packages/rab-mobile`: `flutter analyze`, `flutter test`, `flutter build apk --profile`. Locally Flutter is installed at `C:/flutter/bin`. Important tests: home visual states, shift motion, navigation geometry, clock screen, schedule consistency, root-gate isolation, Venue Manager and report contracts. For backend changes run relevant integration/security suites using `packages/rab-server/package.json` scripts and `testing/integration-test-identities.md`. Never regenerate goldens without inspecting changes.

## 14. Known issues

Colour mismatch from encounter-order, list-index, fixed and status-based selection is resolved. Supplied screenshots alone do not prove two records share a Shift id. Title/rate discrepancies must be investigated separately using real ids if they persist. The existing Upcoming list can overlap rows near its pinned header while scrolling; this colour-only task did not redesign that layout.

### Open security follow-up
- MAIL-DEP-01 — Nodemailer dependency review: current package version is `^9.0.5`. Historical security remediation recommended `^9.1.0`. This has NOT been remediated or re-verified yet. Handle in a separate dependency/security task; do not change it during repository cleanup.

## 15. Pending work

No remaining implementation work for the session-based colour-distribution task. Native QA covered the same five IDs in Staff Home/Upcoming/Calendar/Details, then completed History, and Venue Manager Calendar. History fixtures were completed through real signed-QR/geofence clock APIs after isolated fixture schedule adjustment; this is not a native scanner-flow test. Physical-device release QA and the existing Upcoming pinned-header overlap remain separate. Broad historical audit completion must not be inferred from this narrow colour check.

## 16. Decisions made

One canonical handoff here; AGENTS/CLAUDE link to it. Read it before edits, verify against current code and update after material work. No secrets or raw personal data. Do not duplicate stored project state in competing handoffs.

## 17. Do not regress

Stable shift colours; card morph and rear-layer handoff; fixed nav centres; authoritative completed state; role isolation; organisation/workspace RLS; server QR/geofence validation; API/Worker boundaries; secure shared storage; no production mock logic.

## 18. Last session handoff

2026-09-22: replaced direct hash-to-colour assignment with one session registry and whole-group allocation. Changed shared style resolver, OffersProvider, VenueManagerProvider, shared Upcoming deck registration and History registration; existing surface consumers inherit the registry. Added collision, palette exhaustion, neighbour avoidance, immutable mapping and session-repeatability tests. Analysis clean, 231 tests passed (including unchanged goldens and motion tests), Android profile build passed. Native screenshots inspected for five distinct palette colours and stable identity through Staff Upcoming/Home/Calendar/Details/History and VM Calendar. Three QA users deactivated, refresh tokens revoked; five completed shifts/attendance and immutable audit records retained. No production backend or motion/navigation/layout changes. Local QA evidence was intentionally removed from source control. Next: physical-device release QA; persistent colours across cold restarts would require an explicit local-cache extension, not a return to direct hash mapping.


## 19. Latest session: Today/Details lifecycle (2026-09-22)

Implemented Next/Today/Live Home ? same ScheduleOfferDetailScreen through existing pastel morph. ShiftStatusControl renders Pending, Confirmed, server-anchored HH:MM:SS, Clocked Out, Complete and Expired. NOTE always appears; missing note ? No Details. Organisation timezone defines Today. Flutter uses server time plus monotonic elapsed interpolation; official duration/pay stay server-owned. Successful Clock Out retains its authoritative response, and stale live projections show Updating status until reconciled.

The subsequent Worker requirement supersedes the initial read-time-only projection. API persists clock-out immediately. Existing shift-monitor polling calls PostShiftLifecycleService for discovery and per-row advancement using runScopedForOrg, runtime RLS, explicit scope, row locks and atomic audit. Attendance payroll status remains unchanged; post_shift_completed_at and post_shift_expired_at persist clockOutAt +2h and +6h. Migration 1786672700000 adds columns, ordering constraint, due index and correction-reset trigger. No new enum/queue/runtime. PostgreSQL handles all threshold arithmetic. Existing five-minute cadence may process after eligibility; restart catches up from persisted clockOutAt. API reads milestones only. Null-workspace legacy records are excluded.

Final validation: clean Flutter analysis; 244 tests including unchanged goldens/motion/colour/navigation; Android profile build and install passed; server type-check passed; 12 projection tests, 6 Worker integration cases and 78 offer/attendance security integration cases passed. Worker tests include exact DB boundaries, discovery, concurrency, once-only audit, rerun/restart, corrections and tenant denial. Native camera Clock In/Out used the same signed QR on a dedicated QA shift with valid geofence. Timer increased and survived restart. Clocked Out, Worker-persisted Complete, Expired after restart, notes, Calendar/History and Next-card forward/back morph were verified. Timed native QA invoked the production service scoped to its fixture rather than globally sweeping unrelated data.

Cleanup completed: QA accounts deactivated, hashes cleared, tokens revoked, unused future shift cancelled; completed attendance and immutable audit retained. Private credential/QR files removed and camera poster reset. Local QA evidence was intentionally removed from source control.

Release action: deploy migration before revised API/Worker; production deployment and physical-device checks are not part of this local task. Polling latency and inherited bounded owner-discovery locks are documented limitations. This does not certify the older broad UI audit. Existing unrelated dirty changes were preserved.


## 20. Home primary card colour correction (2026-09-22)

User explicitly restored the original fixed peach background (`ScheduleTokens.homePeach`, #F8ECDF) for the main Today/Next/Live card. This card is an intentional exception to per-shift identity colours; its background stays unchanged across records/states. Upcoming cards and Details retain the existing shift palette. The shared morph accepts an optional source colour so the fixed peach source transitions smoothly into Details without an initial colour flash. Lifecycle, routing and backend logic are unchanged.

Verification: targeted Home visual-state and shift-motion suites passed (71 tests).

## 21. Staff shift UI cleanup (2026-09-22)

Home primary compact card now shows actual shift date instead of address, preserving its fixed peach colour, venue, rate and time. UpcomingShiftCard reuses ScheduleRecordCard with optional scheduleLabel for date/time; its original compact height, Team Member and rate remain. The shared Job Details action builder renders a footer only for actionable offers, Clock In/Out, loading or errors. Removed Be Ready, Back to shifts and repeated passive lifecycle footer panels/text. Central ShiftStatusControl, actual Note/No Details, SafeArea and normal Back remain unchanged. No backend, lifecycle, palette or morph implementation changes.

Verification: flutter analyze clean; all 244 Flutter tests passed; profile APK built and installed. Metadata assertions cover Home dates/address removal and Upcoming date/time/team; lifecycle tests enforce a single status and absent footer CTAs. Reviewed Upcoming idle/pressed golden changes; golden fixtures now accept a fixed date to avoid time-dependent snapshots. Native Today/Upcoming, confirmed/no-note and clocked-out/real-note screenshots captured and inspected; top Back restored Home. QA attendance was prepared through real signed-QR/geofence APIs, not a repeat native scanner test. Local QA evidence was intentionally removed from source control. Next: normal physical-device release checks.

QA cleanup verified: all three disposable users deactivated, credentials cleared, tokens revoked and unused shift cancelled. Completed attendance/audit retained; local private credential/QR artifacts removed.

## 22. Production storage incident â€” Cloudflare R2 / S3 driver fixed (2026-09-24)

Root cause: `packages/rab-docker/docker-compose.production.yml` (the file OpenShip
deploys from) hard-coded `STORAGE_DRIVER=LOCAL` with a volume shared between rab-api
and rab-worker. An operator had set `STORAGE_DRIVER=S3` via OpenShip's own
environment-variable UI (overriding the committed default), but the env validator only
accepted `LOCAL` â€” both containers refused to boot. Fixed the compose file to the real
R2 shape (`STORAGE_DRIVER=S3`, `STORAGE_KEY_PREFIX=production`,
`S3_FORCE_PATH_STYLE=true`, `S3_SERVER_SIDE_ENCRYPTION=NONE` â€” R2 encrypts at rest
automatically and rejects AWS's SSE request headers) and removed the shared volume
(no longer needed or correct once storage is genuinely shared via R2, not a container
disk).

Also fixed, found during this incident: `S3_ENDPOINT` was not actually required when
`STORAGE_DRIVER=S3` (R2 has no default endpoint to fall back to â€” this alone could
cause a second, identical-looking incident); `STORAGE_KEY_PREFIX` had no
normalisation, so a trailing/leading slash produced a malformed key and a `../`
segment was not rejected â€” added `normaliseKeyPrefix()` (`storage-key-prefix.ts`),
applied at every key-building call site and validated at boot; `S3_FORCE_PATH_STYLE`
silently coerced any non-"true" value to `false` instead of failing validation.

Storage architecture itself (`FileService`, `S3StorageDriver`, `FileAccessRegistry`,
`stored_file` metadata table) already existed in this working tree from an earlier
session â€” see Â§11 above â€” this session's work was making it match the actual R2
production target and closing the gaps that would have caused a repeat incident, plus
adding real unit test coverage (mocked AWS SDK client â€” `s3.driver.spec.ts`,
`storage-driver.factory.spec.ts`, `storage-key-prefix.spec.ts`) that did not exist
before: previously the driver was proven only by integration tests gated behind a
local MinIO container, meaning ordinary CI never actually exercised the S3 code path.

One real pre-existing test-fixture bug found and fixed along the way (not a
production defect): `attendance-storage-outage.integration.spec.ts` seeded a `Shift`
directly at `status: 'open'`, which `SHIFT_TRANSITIONS` does not permit transitioning
to `in_progress` from â€” clock-in correctly rejected it with 409. Fixed the fixture to
seed `confirmed`, matching what the real request-approve-accept flow produces.

Verification: 61 new/updated unit tests (mocked S3 client, prefix normaliser, driver
factory, env-validation conditional matrix) all pass with zero infrastructure. Full
storage integration matrix (file-storage-security, report-storage-multiworker,
attendance-storage-outage, storage-s3-driver â€” real MinIO + real PostgreSQL) â€” 64/64
pass. Full server suite (LOCAL driver, default path) â€” 620/620 non-skipped pass, one
stale test count fixed (`identity-security-table-rls` â€” `avatar_file_id`'s legitimate
grant moved the safe-column count from 15 to 16; `password_hash`/
`totp_secret_encrypted` remain excluded, verified, not weakened). `docker compose
build` (amd64) and `docker buildx build --platform linux/arm64` (QEMU emulation â€”
production's actual Oracle Ampere architecture) both succeed, including argon2's
native build. Real Cloudflare R2 smoke test: BLOCKED â€” no real R2 credentials
available in this environment; not fabricated.

Next: apply the corrected `docker-compose.production.yml` (or the equivalent
OpenShip service definitions) and confirm `rab-api`/`rab-worker` boot cleanly against
the real `rab-production-storage` bucket; a real R2 PutObject/GetObject/DeleteObject
smoke test against production credentials remains outstanding, off this machine, with
someone who holds them.

## 23. OpenShip production deployment attempt (2026-09-24)

Read-only verification fetched origin/main at ae42c789b2b648136e090cb1ad9e318b3cbb90dc and confirmed 7da705a8eb525443920e91585f95e42fc166142b is its ancestor. Committed source accepts LOCAL/S3, includes StorageDriver.S3 and S3StorageDriver, conditionally requires S3 settings, and omits SSE headers for NONE. Production compose configures both processes for S3 with production prefix and no shared file volume. Docker build compiles the backend; .dockerignore excludes dist. StoredFileMetadata migration 1786672600000 exists; only API startup runs migrations. These are source checks, not proof of the deployed image or applied migration.

First blocker: the connected OpenShip project list returned zero projects; health inventory was also empty. Browser fallback could not initialize because of a Windows sandbox ACL error. Public GET /healthz returned HTTP/1.1 502 Bad Gateway from openresty/1.27.1.1 at 17:40:37 UTC. The 502 does not establish whether the cause is API failure or routing.

No production configuration, deployments, code, database records, objects or emails were changed. Existing dirty work was preserved. Runtime environment, deployed SHA/image, Redis topology, Neon, migrations, ARM64 dependencies, API/Worker stability, real R2/storage health and cross-process checks remain unverified. PDF/email checks remain blocked pending production access and identification of approved QA data/recipient. No secrets were printed. No fresh build or stability window occurred.

Next action: provide the production OpenShip project URL/ID and connect the account/organization containing it. Then inspect actual services/env, deploy a fresh current-main build, verify compiled S3 support, migrate/start API before Worker, run safe storage probes and observe 5-10 minutes. Do not infer success from source verification or switch to LOCAL storage.

### Production deployment recheck (2026-09-24, 17:54 UTC)

Fresh origin/main fetch still resolves to ae42c789b2b648136e090cb1ad9e318b3cbb90dc; S3 commit ancestry exits 0. Reverified committed LOCAL/S3 validation, conditional S3 requirements, factory S3 branch, NONE encryption header omission, production compose, Docker dist build/exclusion and API-only migration startup. No deployed-image or runtime conclusions follow from these source checks.

Connected OpenShip again returns zero projects and zero deployments. Health inventory is empty with watching=false and watcher.available=false, so it cannot establish service health. Browser fallback failed to initialize (trusted Node process exited). Public /healthz returned HTTP/1.1 502 Bad Gateway, Server openresty/1.27.1.1, Date Thu, 24 Sep 2026 17:54:44 GMT; body is the standard 502 HTML page.

No production mutation, build, migration, object write, email, code change or commit occurred. Existing work preserved; secrets not read or printed. Runtime env, Redis/Neon topology, migrations, R2 tests, cross-process/PDF/email checks, ARM64 and stability remain blocked/unverified. Requested the production project URL/ID and reconnection to its account/organization. This remains the next required action; do not create a replacement project or claim deployment success.

### New OpenShip project authorized and created (2026-09-24)

User explicitly requested a new project after the existing production project was inaccessible. Created rab-production (proj_1uU5_cs7C9Yydflv) in the connected desktop/self-hosted OpenShip instance from Rabblo06/rab-recurit, main, production compose path packages/rab-docker/docker-compose.production.yml. Prepare independently resolves main to ae42c789b2b648136e090cb1ad9e318b3cbb90dc. GitHub access through the instance gh CLI works.

Persisted rab-api, rab-worker and rab-redis service definitions, Docker build context/file, start scripts, health checks and restart policies. API and Worker have identical non-secret S3/R2 settings including required bucket, prefix, region, path style, NONE encryption, TTL and upload bound. No shared storage volume. REDIS_URL intentionally not assigned pending confirmation of the real production topology; do not silently migrate from external Redis. Project environment list is empty: production credentials are not configured. No secret values accessed or printed.

No deployment launched: instance has no default server/deployment target and the new project serverId is null. Asked for the Oracle server ID/URL and secure production env configuration. No existing routing/domain modified, database migration executed or worker launched. New project is configured but NOT built, deployed or healthy. Next: assign intended Oracle host, securely configure and verify both services' effective production env (including existing Redis choice), then fresh build, staged startup, image/R2/connectivity verification and stability observation. Existing local code work untouched.

## 24. Independent Adolphus marketing website (2026-09-25)

User redirected the frontend task to packages/rab-website (the moved directory), separate from RAB SaaS. Built a standalone Next.js/React/TypeScript/Tailwind marketing site with its own npm lockfile, no SaaS imports/env/API usage and no parent workspace configuration changes. Root README now references the user's moved packages/rab-readme images and lists the new website path; all five image links resolve. User's asset moves and existing dirty backend/mobile work preserved.

Implemented original Adolphus navigation/hero, recruitment illustration, dark recruitment flow, process, employer/candidate paths, sectors, inactive role examples, trust, CTA/footer, Jobs/Contact and explicit legal draft routes. Public company content audit, proposed-brand approvals and missing reference-video/hero-source limitations are documented under packages/rab-website/docs. No invented jobs, client logos, metrics or testimonials; contact uses phone and hospitality CV mailto only. No production deployment or infrastructure change.

Verification: production build, lint, TypeScript and four viewport Chrome checks passed; no horizontal overflow, mobile Sheet focus/Escape/restore and reduced motion verified; zero tested axe WCAG violations. QA fixed dark-section logo contrast and heading hierarchy. Final mobile Lighthouse: 99 Performance, 100 Accessibility, 100 Best Practices, 100 SEO; LCP 2.2s, CLS 0, TBT 20ms (local lab, not field INP). A 10.84s scroll video and 16 sampled frames were inspected. See packages/rab-website/docs/REBUILD-REPORT.md for artifacts and packages/rab-website/docs/HANDOFF.md for future website work.

Next: review local site on port 3100; approve legal text/branding/copy and confirm contact/sector details before public launch. Provide the missing reference video/source for exact comparison if desired. Previous backend deployment task remains separate and its production health is not inferred from website work.


### Adolphus second-section refinement (2026-09-25)

Implemented the latest scoped website brief in packages/rab-website only, plus this required handoff entry. RecruitmentStack now contains original employer/candidate cards, the user-supplied image/hero.jpg hospitality photograph, front sector spotlight, editorial statement and sector links. Added scoped CSS and a cleaned-up native observer/event-driven motion hook; no dependencies, hero/header/routes/SaaS/production changes. Desktop stagger/parallax/pointer/exit, tablet simplification, deliberate mobile stack, reduced motion and no-JS fallback are implemented.

Verification: production build, lint, typecheck, existing whole-site Chrome suite and eight-size section suite passed, zero tested axe violations or console errors/warnings. Local 9.08-second motion recording and 20 sampled frames reviewed; pointer/reset and bounded exit assertions passed, observed layout-shift sum 0. Previous Lighthouse results are historical, not remeasured for this change. See packages/rab-website/docs/RECRUITMENT-STORY-REPORT.md and its HANDOFF.md. No deployment. Remaining: sector query links reach Contact but do not prefill a sector; actual reference video still absent (PDF supplies static composition only); pre-existing public-launch approvals remain. Next: user visual review at localhost:3100/#connections.

## 25. Backend remediation program â€” replacement-staff workflow correctness (2026-09-27)

Separate track from Â§22-24 (storage/deployment/website): a multi-phase backend hardening
program on `packages/rab-server`/`packages/rab-worker` covering worker-event idempotency
(Phase 2), late-clock-in correctness (Phase 3), and now the replacement-staff approval
workflow (Phase 4 â€” this entry). None of this is deployed; all uncommitted in the working
tree alongside other in-progress changes noted in git status.

**Phase 4 central fix**: `ReplacementRequestService.approve()`/`reject()`
(`modules/offer/services/replacement-request.service.ts`) previously split the approval
flow across three separate `runInTenantContext` calls with a plain read-then-check â€” two
concurrent managers approving different candidates for the same request could both pass
the check and both get an offer sent, with only the last DB write "remembered." Rewrote as
one atomic-claim transaction: `UPDATE ... SET status='approving' WHERE status IN
(awaiting_approval, no_candidates) RETURNING` claims the row; a genuinely-ineligible
candidate throws (rolls back, releasing the claim so a different candidate can be tried);
a vacancy that's disappeared (shift cancelled/completed/fully staffed) commits a real
`cancelled` terminal state via a discriminated return value, then throws 409 from outside
the transaction so the write survives but the caller still sees a conflict. New
`OfferService.sendOneWithManager()` (offer.service.ts) lets this all run as ONE
transaction â€” reuses the existing private `sendOne()` verbatim, deliberately skipping
`loadSendableShift()`'s shift-ownership gate (which doesn't apply to a manager approving
someone else's shift's replacement).

**A real, previously-undetected driver bug was found and fixed while testing this**:
TypeORM's `manager.query()` returns `[rows, rowCount]` (a 2-element tuple) for `UPDATE`/
`DELETE` statements, never the rows array directly (unlike `SELECT`/`INSERT`, confirmed
against `node_modules/typeorm/driver/postgres/PostgresQueryRunner.js`). The first version
of the atomic claim checked `claim.length === 0` â€” always false, since the outer tuple's
length is always 2 â€” silently defeating the entire claim mechanism (proven by a live
5-way-concurrent test: all 5 approvals "succeeded"). Fixed by destructuring
`const [claimedRows] = await manager.query(...)` and checking `claimedRows.length`,
matching the already-correct established pattern in `offer.service.ts`'s
`confirmAssignment`. The identical mistake was found and fixed in
`shift-cancellation-followup.job.ts`'s replacement-request cancel-out step (miscounted,
never mis-wrote â€” the UPDATE's WHERE clause was always correct, only the returned count
was wrong). The same bug also exists in `queue-worker/rab-reports/final-timesheet.job.ts`
(`claimed.length === 0`) â€” **not fixed**, out of Phase 4 scope (attendance/reports
feature, different plan) â€” flagged here for whoever picks that up next.

Also fixed in this phase: `replacement-staff.job.ts`'s `isAvailableOnDay()` used
`startsAt.getUTCDay()` (wrong weekday for any shift whose UTC and Europe/London calendar
dates differ, e.g. just after midnight UTC in BST) â€” now uses
`getLondonDateParts().weekday`; manager-recipient resolution now reuses Phase 3's
`resolveResponsibleManager()` instead of a raw, unvalidated `assignedBy` read; ranking gained
an explicit `staffProfileId` tie-break for determinism.

New test suite: `rab-worker/src/__tests__/integration/replacement-staff-workflow.integration.spec.ts`,
41 real-Postgres/RLS-on tests (idempotency, eligibility incl. the timezone fix, ranking,
manager resolution, 5-way double-approval, approve-vs-reject, approve-vs-cancellation,
stale-candidate revalidation, `OfferService` integration, cross-org/cross-workspace/IDOR/
no-context RLS, audit-exactly-once). All 41 pass. Phase 2/3 regression suites re-run and
pass (`worker-event-idempotency`, 17 tests; `late-clock-in-correctness`, 25 tests â€” one
transient lock-timeout failure on first run, confirmed a resource-contention flake, not a
regression, by a clean isolated re-run). `rab-server`/`rab-worker`/`rab-shared` typecheck
and lint clean. EXPLAIN run (not assumed) on both the candidate-discovery scan and the
eligibility-overlap revalidation query before deciding no new index is justified at
current/near-term scale â€” both already use appropriate existing indexes
(`job_offer_shift_assignment_id_key`, `shift_pkey`, `shift_assignment_no_double_booking`).

Known pre-existing, unrelated failure reconfirmed still present, not touched: the
account-invite-cleanup batch-crowding issue (`account-invite-cleanup.integration.spec.ts`,
"safely hard-deletes a genuinely dependency-free account" â€” `deleted` count 0, expected
â‰¥1) â€” a job-cycle-scan batching interaction unrelated to replacement-staff, tracked for a
future phase, not hidden.

Next: apply the same atomic-CAS/driver-shape audit to `final-timesheet.job.ts`; Phase 5
(recommended starting point, per the Phase 4 completion report): the account-invite-cleanup
batching defect, or MFA/session-revocation/refresh-rotation hardening â€” user's call.

## 26. Backend remediation program â€” shift cancellation correctness (2026-09-27)

Phase 5 of the same track as Â§25. Core invariant: a cancelled shift can never be advanced
as if it were still active, across every path that touches it.

**`SchedulingService.cancel()` was previously unaudited and unlocked**: a plain
`assertTransition` + blind `update()`, no `AuditService.record` call at all, no
`cancelled_by`/`cancelled_at` columns (only `cancelled_reason` existed, unlike
`approved_by`/`approved_at`/`declined_by`/`declined_at`, which already existed on the same
`Shift` entity for its sibling transitions). Rewrote as an atomic claim
(`UPDATE ... WHERE status = :priorStatus RETURNING`, the same CAS idiom as Phases 2-4),
added `cancelled_by`/`cancelled_at` (migration `ShiftCancellationColumns1786673400000`,
matching the existing `approved_by`/`declined_by` pattern exactly), and added the first-ever
`shift.cancelled` audit action.

**Two real, previously-unguarded races fixed**: `OfferService.staffAccept()` never checked
the underlying shift's status at all on its common (non-auto-confirm) path â€” a shift
cancelled between send and accept let the accept through anyway, creating a
`STAFF_ACCEPTED` assignment on a dead shift. `OfferService`'s private `applyConfirmation()`
(shared by `managerConfirm()` and staffAccept's auto-confirm path) was ONLY accidentally
safe via a downstream `assertTransition` throw inside the filled-seat claim â€” correct by
side effect, not by design, and only for ONE of its two callers' full paths. Both now lock +
reload the shift (`pessimistic_write`) explicitly, before touching the offer/assignment, as
the very first thing they do â€” serialising against `cancel()`'s own row UPDATE on the exact
same row.

**A previously-undetected consistency gap across every worker job that revalidates a
cancelled shift before firing a side effect**: `shift-monitor.job.ts`'s reminders/no-show
had only a single pre-claim re-check, never a Phase-3-style "Pass B" re-check immediately
before the irreversible notify/audit (closed by mirroring `late-clock-in.job.ts`'s own
established two-pass shape); `offer-expiry.job.ts`'s manager-confirmation-timeout escalation
never checked shift status AT ALL (full Pass A/claim/Pass B rewrite, matching Phase 3's
pattern exactly); `attendance-monitor.job.ts`'s missing-clock-out re-check never repeated
its own discovery query's `s.status != 'cancelled'` exclusion (one-line consistency fix,
attendance facts themselves â€” `clockInAt`/`clockOutAt` â€” were never at risk either way);
`shift-report-scheduler.job.ts`'s pre-shift roster+QR generation had the identical gap in
its own `reportNeedsGeneration()` re-check (fixed the same way).

**The `final-timesheet.job.ts` affected-row bug Phase 4 found but didn't fix (out of that
phase's scope) is now fixed** â€” the identical `manager.query()` `[rows, rowCount]` misread
as Phase 4's original replacement-approval bug, fixed with the same destructuring pattern.

**Queued email revalidation** (Â§14): the pre-shift roster+QR email's `email-send.processor.ts`
send-time `revalidate()` now also checks â€” via the file's own existing structured
`stored_file.resource_type`/`resource_id` linkage, no new column â€” whether the underlying
shift has been cancelled since the email was queued, and cancels the row instead of sending
a stale "active shift" roster. Deliberately scoped to `FileKind.SHIFT_ROSTER_PDF` only: the
final Timesheet PDF is historical truth by construction (only reachable once a manager has
explicitly finalised the report) and must keep sending regardless of later cancellation.
Caught and fixed a real bug in this fix itself during testing: the check's own DB read needs
`row.workspaceId`-bound tenant context, not the outer job-level ctx (deliberately
workspace-null, since an ordinary `EmailOutbox` row isn't itself workspace-scoped) â€” the
first version silently no-op'd because `StoredFile`'s FORCE'd RLS made the row invisible
under the wrong context, mirroring the existing attachment-read step's own `fileCtx` pattern
to fix it.

New test suite: `shift-cancellation-correctness.integration.spec.ts`, 28 real-Postgres/
RLS-on tests (basic cancellation incl. audit/columns/RLS/IDOR, offer-accept and manager-
confirm races both directions plus real concurrent `Promise.allSettled` races, reminder/
no-show/manager-confirmation-timeout suppression with "not cancelled" controls proving the
suppression is real, replacement-vs-cancellation Phase 4 regression, attendance history
preservation, pre-shift-report suppression, the final-timesheet affected-row regression,
and queued-roster-email revalidation). All 28 pass. Existing `rab-server` abuse-case suites
covering the same accept/confirm/cancel HTTP routes (`scheduling-offer-abuse-cases`,
`attendance-abuse-cases`, `resource-ownership-abuse-cases`, 86 tests) re-run clean â€” no
regression from the `staffAccept`/`applyConfirmation`/`cancel` rewrites. Phases 2-4
regression suites re-run clean (one transient lock-timeout failure under full-suite
contention, confirmed a pre-existing environment flake by isolated re-run, not a
regression). `rab-server`/`rab-worker`/`rab-shared` typecheck and lint clean.

Newly discovered, unrelated defect (not fixed, flagged for later): `attendance-monitor.
job.ts`'s discovery scan has no per-organisation narrowing option (unlike offer-expiry/
final-timesheet/shift-report-scheduler) and orders `LIMIT 500` by `ends_at ASC` â€” the same
class of batch-crowding limitation already tracked for `account-invite-cleanup.job.ts` can
starve a fresh candidate out of its scan window under heavy accumulated backlog.

Known pre-existing, unrelated failure reconfirmed still present, not touched: the
account-invite-cleanup batch-crowding issue (same as reported in Â§25).

Next: the account-invite-cleanup and attendance-monitor batch-crowding defects (both now
diagnosed as the same underlying pattern â€” no org-scoping + unbounded backlog ahead of a
fixed LIMIT), or MFA/session-revocation/refresh-rotation hardening â€” user's call.

## 27. Same-organisation manager isolation (2026-09-27)

Phase 5.5 â€” a targeted audit + fix, not another broad sweep. Core question:
does matching `organisationId` (or even `organisationId` + `workspaceId`)
let one Internal Manager see/act on ANOTHER Internal Manager's own
private data, purely because they share a tenant? The audit read every
manager-facing service's actual `list()`/`get()`/mutation logic (not
guessed) to find out.

**Finding: most of this codebase already gets it right.** Shift
(`SchedulingService.assertShiftOwned`), Offer (`OfferService.
assertOfferOwned`), Staff (`StaffService.assertOwned`), Venue
(`VenueService`'s equivalent), Attendance (`AttendanceService.
assertCanManageAttendance`), and Report/Timesheet (`ShiftReportService.
canReadShift`, reused verbatim by `ReportFilePolicy` for file downloads â€”
so a signed URL can't bypass what the read endpoint already denies) all
already gate every manager-facing read/write through a real per-manager
ownership chain (`createdBy`/`assignedBy`, walked to the owning `Shift`
where the entity itself has no direct owner column), not merely RLS's
organisation/workspace boundary. This is pre-existing "Stage 2A" work,
confirmed by reading the actual current source, not assumed from a
pattern seen once.

**Two confirmed, real gaps, both fixed:**
1. **`ReplacementRequestService`** (`list`/`get`/`approve`/`reject`) â€” a
   Phase 4 addition that never received the same treatment. It had NO
   manager-ownership check anywhere; RLS (org + workspace, plus a venue-
   manager carve-out) was the ONLY boundary. A same-org, same-workspace
   Manager B holding the ordinary `SCHEDULE_VIEW`/`OFFER_SEND` permission
   every manager already has could list, view, approve, or reject Manager
   A's replacement requests outright. Fixed by deriving ownership the way
   this phase's own brief specifies â€” `shiftId -> Shift -> createdBy`/
   venue-assignment â€” mirroring `SchedulingService`/`ShiftReportService`'s
   own already-established 4-line check (duplicated per this codebase's
   existing precedent for this exact check, not a new shared abstraction).
   The ownership check runs BEFORE `approve()`/`reject()`'s existing Phase
   4 atomic claim, never after â€” an unauthorised Manager B must never be
   able to consume the claim even transiently, which would otherwise make
   Manager A's own concurrent, legitimate approval spuriously fail as
   "already resolved" (proven with a real 2-way concurrent test: Manager
   B denied, Manager A's own approval still succeeds).
2. **`DashboardService`**'s aggregate counts (staff/venue/active-offer,
   `owner` scope) â€” used `workspace_id` alone, on the DOCUMENTED
   assumption that it's equivalent to `created_by` because "a fully-
   onboarded Manager's own private ManagerWorkspace has exactly one
   member." Confirmed live that this is an application-level assumption,
   never a database-enforced invariant: `manager_profile.workspace_id`
   has only a plain index, no UNIQUE constraint. Nothing in the schema
   stops two `owner`-scope managers from sharing one workspace (no
   product feature does this today, but the phase's own brief demands
   defense-in-depth against exactly this â€” "same workspace alone grants
   no manager-private access"). Fixed by adding `created_by = ctx.userId`
   back as a second, ANDed condition â€” tightening only, since the two
   predicates already agree on every real row today.

**The adversarial test fixture** (`same-org-manager-isolation.
integration.spec.ts`, 17 tests): Manager A and Manager B, same
organisation, same workspace, same production permission set, different
user ids. Since no onboarding path produces two Internal Managers sharing
one workspace, the fixture forces it directly (Manager A onboards
normally; Manager B onboards normally with NO workspace, then a single
owner-connection UPDATE points their `manager_profile.workspace_id` at
Manager A's) â€” removing organisation/workspace/permission equality as a
possible explanation for any denial. Covers staff/venue/shift/offer/
replacement/attendance/report list+detail+mutation isolation, notification
and audit-feed isolation, dashboard-aggregate isolation, the shared
`PENDING_MANAGER_APPROVAL` queue as a deliberate positive-control
exception (still visible to any approver, by design â€” never widened
beyond that one status), an explicit "admin never gets a blanket bypass"
check, and dedicated Phase 3/4/5 regressions re-run under this exact
fixture (late-clock-in manager resolution, replacement approval, shift
cancellation) â€” Phase 4's own prior tests had mainly proven cross-org/
workspace isolation, never this same-workspace case, which is exactly why
the `ReplacementRequestService` gap survived undetected until now. All 17
pass. Phase 2-5 regression suites (111 tests) and the existing `rab-server`
abuse-case suites (`scheduling-offer-abuse-cases`, `attendance-abuse-
cases`, `resource-ownership-abuse-cases`, 86 tests) re-run clean â€” no
regression from either fix. Typecheck/lint clean across `rab-server`/
`rab-worker`/`rab-shared`.

RLS remains exactly what it already was: the OUTER tenant boundary
(organisation + workspace, or an `EXISTS`-based venue-manager carve-out on
a few tables) â€” it structurally cannot cheaply distinguish Manager A from
Manager B within one organisation/workspace without a manager-id column
on every table, so it was never weakened or asked to do more than that.
The INNER, manager-ownership boundary lives in the service layer, exactly
where it already lived for every entity except the two fixed here.

No unrelated work touched (Phase 6 offer-expiry races, MFA, session
revocation, refresh rotation, caching, account-invite-cleanup/attendance-
monitor batch-crowding â€” all left exactly as previously reported).

Next: Phase 6, or the two now-diagnosed batch-crowding defects â€” user's
call.

## 28. Staff response / offer expiry correctness (2026-09-27)

Phase 6 â€” made the `JobOffer` lifecycle concurrency-safe under real
Postgres load, while leaving the Private Manager Workspace architecture,
`OfferService.assertOfferOwned` ownership model, and staff-identity
resolution (`ctx.userId -> StaffProfile -> staffProfileId`) untouched â€”
all three were re-verified against current source and confirmed already
correct, not redesigned.

**One real, pre-existing bug fixed** in `offer-expiry.job.ts`'s
`runOfferExpiryCycle`: the per-candidate expiry write was a blind
`manager.update(JobOffer, offer.id, {status: EXPIRED})` with no `WHERE
status = 'pending'` guard at all â€” a genuine "worker reads PENDING / staff
accepts / worker blindly overwrites to EXPIRED" race, capable of stamping
an already-accepted offer EXPIRED underneath a staff member who had just
taken it. Fixed by a new shared, standalone function,
`packages/rab-server/src/modules/offer/services/claim-expired-offer.ts`'s
`claimExpiredOffer()` â€” one atomic `UPDATE ... WHERE status = 'pending'
AND expires_at <= now() RETURNING`, imported directly by both
`offer-expiry.job.ts` (`rab-worker`, no NestJS DI container, so it needs a
plain importable function, not an injected service method â€” same
precedent as Phase 3's `resolveResponsibleManager`) and `OfferService.
staffAccept()`. Real Postgres `now()` is the sole authority for "has this
offer expired," never Node's `Date.now()` or a client clock.
`staffAccept()`'s own lazy-expiry pre-check had the same blind-update
shape plus the `Date.now()` violation; folded into one atomic claim
(`WHERE status = 'pending' AND expires_at > now()`) that decides
accept-vs-expire in a single UPDATE â€” whichever side's claim actually
affects a row is the only one that may fire the `OFFER_ACCEPTED`/
`OFFER_EXPIRED` audit and notification.

**One real bug found and fixed by the new test suite itself** (not
assumed correct): the first draft of `staffAccept()`'s "not accepted â€”
find out why" branch called `claimExpiredOffer()` and then, on success,
threw `ConflictException` to report the failed accept â€” all inside the
SAME `runInTenantContext` transaction. `TenantContextService.
runInTenantContext` wraps its callback in `dataSource.transaction()`;
any throw from inside it rolls back everything the transaction wrote,
including a `claimExpiredOffer()` call made moments earlier in that same
transaction. The result: a staff member's own request correctly reported
"this offer has expired," but the expiry claim and its audit row were
silently discarded every time, leaving the row still `PENDING` in the
database â€” caught by test `E27` (expected `expired`, got `pending`) once
a real accept-after-deadline case was exercised with no worker involved
to independently commit the transition. Fixed by restructuring
`staffAccept()` into two sequential (never nested) transactions: the
first attempts the atomic accept claim and returns a discriminated
result instead of throwing on a miss; the second â€” entered only on a
miss, and only if the first didn't already resolve to a real acceptance â€”
runs `claimExpiredOffer()` plus its audit/notification and returns
normally (so it commits for real) before the `ConflictException` is
thrown from *outside* any transaction. The auto-confirm path's existing
"roll the STAFF_ACCEPTED claim back together with a failed seat-capacity
confirm" behaviour was deliberately left alone â€” that rollback is
correct: an accept that can't secure a seat must not leave the offer
parked at `STAFF_ACCEPTED` with no assignment/seat forever (proven by the
last-vacancy/multi-vacancy tests below). The distinction: an expiry claim
is an objective fact that must persist regardless of this request's own
outcome; a provisional accept claim that can't complete a seat should not.

**Everything else in the brief's 43-section scope was audited by reading
current source, not assumed, and found already correct, unchanged:**
workspace inheritance (`Shift.workspaceId -> ShiftAssignment.workspaceId
-> JobOffer.workspaceId`, plus real composite FK constraints â€” `job_offer_
shift_assignment_workspace_fkey`, `job_offer_staff_workspace_fkey`,
`shift_assignment_shift_workspace_fkey`, `shift_assignment_staff_
workspace_fkey` â€” enforcing it at the strongest possible layer, confirmed
live via psql and by a direct-SQL insert attempt in the new suite);
`decline()`/`withdraw()`/`managerReject()`'s existing atomic `[, count]`
CAS pattern; `applyConfirmation()`'s atomic `filled_count` claim (the
actual last-seat/multi-vacancy lock); staff IDOR resolution (`staffAccept`/
`decline` never call `assertOfferOwned` â€” staff ownership is strictly
`offer.staffProfileId` matched to the caller's own `StaffProfile`, never
`offer.createdBy`); the offer-expiry scan's existing partial index
(`job_offer_pending_expiry_idx ON core.job_offer (expires_at) WHERE status
= 'pending'`), confirmed via `EXPLAIN` (run inside the same disable/
enable-RLS dance the real job uses â€” the plan looks completely different,
RLS-policy-driven, if you EXPLAIN the bare query outside that dance) to
already be an Index Scan, not Seq Scan â€” no new index added, per the
brief's own "don't add blindly" instruction.

**Test suite**: new `packages/rab-worker/src/__tests__/integration/
offer-lifecycle-correctness.integration.spec.ts`, 26 tests across
workspace architecture, Phase 5.5 same-workspace defence-in-depth, staff
IDOR, normal transitions, expiry-boundary DB-time semantics, the core
concurrency races (accept-vs-expire, decline-vs-expire, accept-vs-decline,
5-way duplicate accept/decline/expiry-cycle), last-vacancy and
multi-vacancy capacity concurrency (both the auto-confirm-on-accept flow
and the two-step manual-confirm flow), cancellation integration,
replacement integration, audit/notification-exactly-once under
concurrency, and worker workspace-binding/RLS proof. All 26 pass against
real Postgres with RLS on. Phase 2-5.5 regression suites (worker-event-
idempotency, late-clock-in-correctness, replacement-staff-workflow,
shift-cancellation-correctness, same-org-manager-isolation â€” 209 tests
combined) re-run clean. `rab-server`/`rab-worker` typecheck and lint
clean.

**Recurring environmental note, not a regression**: running all 5
regression suites in one `--runInBand` jest invocation (or two suites'
processes concurrently) produces sporadic `ALTER TABLE ... DISABLE ROW
LEVEL SECURITY` lock-timeout errors and, once, an `ECONNRESET`, each time
on a different, unrelated test (`worker-event-idempotency`'s no-show/
reminder tests, `shift-cancellation-correctness`'s C11/B8/C16/D17) â€” pure
DB-connection contention from this session's sustained sequential local
Postgres load, not a Phase 6 regression: none of the affected tests touch
`offer.service.ts`, `offer-expiry.job.ts`, or `claim-expired-offer.ts`.
Every affected suite was confirmed fully green when re-run truly alone
(no other suite's process running concurrently against the same
container).

No unrelated work touched (account-invite-cleanup/attendance-monitor
batch crowding, MFA, refresh-token rotation, session revocation, backend
caching, image compression, push notifications, general rate-limiter
redesign â€” all left exactly as previously reported, none recurred in this
phase's own test runs).

Next: Phase 7, or the two now-long-standing batch-crowding defects â€”
user's call.

## 29. Manager confirmation timeout correctness (2026-09-28)

Phase 7 â€” made the `STAFF_ACCEPTED â†’ timeout` half of the two-step
confirmation flow actually resolve, atomically, workspace-safe and
concurrency-safe. Reused the existing `OfferStatus`/`ShiftAssignmentStatus`
state machine unchanged (`STAFF_ACCEPTED â†’ MANAGER_REJECTED`/`REJECTED`
were already valid edges, from `OfferService.managerReject`'s own manual
path) â€” no new status added.

**Old behaviour, discovered by Step-0 audit before any edit**:
`runManagerConfirmationTimeoutCycle` never mutated `offer.status` at all â€”
a deliberate, previously-correct "notify/escalate forever, never auto-
resolve" design from an earlier phase. That meant a `STAFF_ACCEPTED` offer
the manager never touched could wait indefinitely, notifying on a loop
with no terminal outcome â€” exactly the gap this phase's brief named. The
single canonical timeout-duration config, `MANAGER_CONFIRMATION_TIMEOUT_
MINUTES` (default 60), was already the sole source â€” no conflicting
constants found, nothing to consolidate.

**Fix**: new standalone function `packages/rab-server/src/modules/offer/
services/claim-manager-confirmation-timeout.ts`'s `claimManagerConfirmation
Timeout()` â€” one atomic `UPDATE core.job_offer SET status='manager_
rejected' ... WHERE status='staff_accepted' AND staff_accepted_at + <timeout>
<= now() RETURNING`, then a same-transaction `ShiftAssignment` transition,
gated on having already exclusively won the offer CAS (same idiom as
`OfferService.managerReject`/`applyConfirmation`, `claim-expired-offer.ts`).
`rejected_by` stays NULL â€” a system timeout never fabricates a Manager
identity; the reason is the fixed string `'Manager confirmation timed
out.'`. `offer-expiry.job.ts`'s `runManagerConfirmationTimeoutCycle` keeps
its Phase 3/5 Pass A / worker_event claim / Pass B shape and its exact
`manager-confirmation-timeout:{offerId}:{staffAcceptedAt}` event key
unchanged; Pass B now calls the new claim instead of just notifying.
Audit reuses the existing dedicated `offer.rejected_by_worker` action
(the SAME one `shift-cancellation-followup.job.ts` already used for the
identical target transition) with `metadata.source =
'manager_confirmation_timeout'`, rather than the old `offer.manager_
confirmation_timeout_flagged` action (kept defined for historical rows,
never written going forward â€” it described a notification-only escalation
that no longer happens). Notification text updated to truthfully describe
a closed-out offer, not a pending nudge; notification TYPE unchanged
(`manager_confirmation_timeout`). Manager-facing recipient resolution
switched from a direct `assignment.assignedBy` read to the Phase-3-
established `resolveResponsibleManager()` helper (assignedBy, falling
back to `shift.createdBy`) â€” the correct existing convention, per this
phase's own explicit "never use staffProfile.createdBy" instruction.

**One real, pre-existing race fixed as an unavoidable supporting change**:
`shift-cancellation-followup.job.ts`'s `JobOffer`/`ShiftAssignment`
updates for a cancelled shift's still-open assignment were blind
(`manager.update()`, no prior-status guard) â€” safe only because nothing
had ever raced those two specific rows concurrently before. Phase 7's new
timeout worker can now race exactly that pair on every tick. Fixed by
making both updates real CAS-guarded `UPDATE ... WHERE status = $expected`
statements, and reordering them (offer claimed first, assignment second)
to match the lock-acquisition order every other offer-lifecycle
transition in this codebase already uses (`managerReject`/
`applyConfirmation`/`claim-expired-offer`/the new timeout claim) â€”
avoiding a real Postgres deadlock risk from the two jobs previously
locking the same pair of rows in opposite orders.

**Index**: `EXPLAIN` (run inside the same disable/enable-RLS dance the
real job uses) showed a Seq Scan for the discovery query â€” no supporting
index existed. Added `job_offer_staff_accepted_timeout_idx ON core.
job_offer (staff_accepted_at) WHERE status = 'staff_accepted'` (migration
`ManagerConfirmationTimeoutIndex1786673500000`), the same partial-index
shape as the existing `job_offer_pending_expiry_idx`. Confirmed via
`EXPLAIN` afterward: Index Scan, not Seq Scan.

**Test suite**: new `packages/rab-worker/src/__tests__/integration/
manager-confirmation-timeout-correctness.integration.spec.ts`, 27 tests â€”
architecture, timeout eligibility/boundary, the atomic transition, the
Venue-Manager-request auto-confirm exclusion (an auto-confirmed offer
never sits at `STAFF_ACCEPTED` even momentarily, so it structurally can
never enter this discovery query), every core race (timeout-vs-confirm,
timeout-vs-manual-reject, timeout-vs-cancellation, 5-way duplicate
timeout/confirm/reject/cancel), workspace/RLS isolation, Phase 5.5
defence-in-depth, worker-event exactly-once, restart/catch-up, and
discovery fairness/index evidence. All 27 pass against real Postgres with
RLS on. Two existing Phase 5 tests (`C16`/`C16b` in `shift-cancellation-
correctness.integration.spec.ts`) asserted on the now-retired notify-only
audit action and were updated to assert the new real transition/action â€”
not a regression, an intentional, brief-mandated behaviour change these
tests needed to catch up with. Phase 2â€“6 regression suites (worker-event-
idempotency 17, late-clock-in-correctness 25, replacement-staff-workflow
41, shift-cancellation-correctness 28, same-org-manager-isolation 17,
offer-lifecycle-correctness 26 â€” 154 tests combined) re-run clean, each
in isolation. `rab-server`/`rab-worker`/`rab-shared` lint clean.

**Real bug this session's own testing caught, not assumed away**: a
systematic test-authoring mistake â€” `core.job_offer`/`audit_log`/
`worker_event`/`shift_assignment`/`shift` all carry `FORCE ROW LEVEL
SECURITY`, and confirmed live that `rab_owner` (the role behind the test
suite's admin `DataSource`) is NOT exempted from it on any of these
(only on the ten allowlisted tables, per CLAUDE.md). Early drafts of the
new test file queried/mutated these tables directly via the admin
connection with no tenant context bound, which RLS silently filtered to
zero rows/zero effect â€” surfacing as "the timeout never resolves anything,
even in the simplest case." Fixed by routing every such query through a
real `rab_app`-role, tenant-bound connection instead. Documented at length
so the same mistake isn't repeated in a future phase's test suite.

**Environment note, not a regression**: this shared local dev database
has substantial live traffic â€” a running `rab-worker-1`/`rab-server-1`
container pair actively processing real shifts/offers/emails/reports â€”
and, at the time of this phase's own testing, several hundred real,
already-overdue `STAFF_ACCEPTED` offers backlogged (the live worker's own
manager-confirmation-timeout tick was repeatedly losing its 250ms table-
lock budget to real API traffic). Every test in the new suite processes
that same real backlog as a side effect of calling the real exported
function against the real shared database â€” correctly resolving genuine
production debt, not a test artifact â€” and each cycle call runs
proportionally slower as a result (~9â€“12s typical, one outlier ~18s,
still well under the 90s per-test timeout). Sporadic `ALTER TABLE ...
DISABLE ROW LEVEL SECURITY` lock-timeout noise recurred under heavy
concurrent multi-suite load, exactly as in every prior phase â€” confirmed
environmental by re-running the affected suite alone.

No unrelated work touched (account-invite-cleanup/attendance-monitor
batch crowding, MFA, refresh-token rotation, session revocation, backend
caching, image compression, push notifications, general rate-limiter
redesign â€” all left exactly as previously reported).

Next: Phase 8, or the two now-long-standing batch-crowding defects â€”
user's call.

## 30. Product-rule correction: timeout auto-confirm + post-shift 1h/2h (2026-09-28)

Phase 7.1 â€” two deliberate business-rule corrections to Phase 7's own
output, both delivered by the product owner after Phase 7 shipped.

**RULE A â€” manager confirmation timeout now auto-CONFIRMS, not
auto-rejects.** Phase 7 (this same day, earlier) implemented
`STAFF_ACCEPTED -> MANAGER_REJECTED` on timeout â€” a real, working
implementation, but the WRONG business rule per this correction: the
system should instead behave as if the manager themselves clicked
Confirm. Fixed by reusing the existing `MANAGER_CONFIRMED` status (no new
status introduced) and, critically, EXTRACTING `OfferService`'s private
`applyConfirmation()` seat-claiming core into a new standalone function,
`packages/rab-server/src/modules/offer/services/apply-offer-confirmation.ts`'s
`applyOfferConfirmation()` â€” the exact same atomic offer-CAS, atomic
`filled_count < required_count` claim, double-booking exclusion-constraint
handling, and audit/notification logic a real Manager's confirm click and
the Venue-Manager-request auto-confirm-on-accept path already used, now
ALSO callable by `offer-expiry.job.ts`'s worker (which has no NestJS DI
container). This is the direct, literal answer to "use the SAME
seat-claiming and safety logic as a real Manager confirmation" â€” not a
second, parallel implementation that could drift.

`confirmed_by` stays NULL for a system confirmation (never a fabricated
Manager identity); audit reuses the existing `OFFER_CONFIRMED` action with
`metadata.source = 'manager_confirmation_timeout'` (the OLD Phase-7
`OFFER_REJECTED_BY_WORKER` write for this path is retired, never written
again). The old, now-obsolete `claim-manager-confirmation-timeout.ts`
(Phase 7's dedicated reject-claim file) was deleted outright rather than
left as dead code.

**Capacity safety is never bypassed.** `applyOfferConfirmation` still
THROWS `ConflictException` on any genuine safety failure (shift full,
shift cancelled, double-booking exclusion violation, or the offer already
resolved by something else) â€” Phase 7.1's own brief explicitly forbids
force-confirming past capacity AND forbids silently falling back to an
auto-reject as a substitute. The worker's per-candidate handler lets that
exception propagate out of its own transaction (rolling back everything
it touched, including the just-claimed `worker_event`), then catches it
one level up in the `for` loop so one stuck candidate can never abort the
rest of a tick's batch â€” this codebase's first job that calls a
legitimately-throwing shared core, so this two-layer catch is new,
documented at length in the job file's own doc comment. A genuinely
transient failure (shift full right now) is retried on a later tick, not
silently discarded.

**Races reconfirmed under the corrected rule**: manual-confirm-vs-timeout
now race toward the SAME outcome (exactly one seat claim either way);
manual-reject-vs-timeout still resolves to exactly one terminal result,
whichever wins; timeout-vs-cancellation is unchanged in mechanics (Phase
7's CAS-guarded `shift-cancellation-followup.job.ts` fix, and its
offer-before-assignment lock order avoiding a deadlock against this
worker, both carry over untouched) but now reconciles a CONFIRMED (not
REJECTED) assignment when timeout wins first â€” already correctly handled
by that file's existing `CONFIRMED` membership in `OPEN_ASSIGNMENT_
STATUSES`, no code change needed there.

**RULE B â€” post-shift display lifecycle: 1h/2h, was 2h/6h.** Three
independent copies of the same two numbers, all corrected together:
1. `PostShiftLifecycleService` (`rab-server`) â€” the authoritative
   worker-driven writer of `core.attendance.post_shift_completed_at`/
   `post_shift_expired_at` â€” now reads `POST_SHIFT_COMPLETE_HOURS`/
   `POST_SHIFT_EXPIRED_HOURS` (new, `@rab/shared`) via parameterized
   `make_interval(hours => $N)`, matching its own already-established
   parameterization rather than a second copy of literal interval text.
2. `resolveStaffShiftPresentation`'s read-only `nextTransitionAt` display
   hint (`rab-server`) â€” now derived from the same shared millisecond
   constants, so it can never drift from the authoritative thresholds
   again.
3. `core.attendance`'s `attendance_post_shift_order` CHECK constraint
   (new migration `PostShiftTimingCorrection1786673600000`) â€” the ONE
   piece that can't be unified with the above two: Postgres has no
   mechanism to reference a JS/TS constant from a CHECK expression, so
   this stays a deliberately-documented, manually-kept-in-sync third copy.

**A real migration hazard found and fixed while shipping this**: this
shared local dev database has substantial live traffic (a running
`rab-worker-1` container processing real attendance rows on its own
5-minute cadence) and `core.attendance` carries FORCE ROW LEVEL SECURITY
with `rab_owner` NOT exempted from it â€” the same RLS-forgetfulness trap
this session hit once already in Phase 7's own test suite. The first two
migration attempts failed: attempt 1 hit a live INSERT racing the
migration's own `ADD CONSTRAINT` validation (fixed with an explicit
`LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` for the whole migration
transaction); attempt 2 then revealed the backfill `UPDATE` was itself
silently matching zero rows (RLS-filtered, no tenant context bound),
leaving all ~510 real existing rows' OLD-formula values in place to
violate the NEW constraint the instant it was added â€” fixed with the
same `ALTER TABLE ... DISABLE/ENABLE ROW LEVEL SECURITY` dance every
worker job's own discovery scan already uses. Third attempt succeeded
cleanly, backfilling 510 real historical rows to the new 1h/2h formula
before the corrected constraint was added.

**Mobile/Flutter**: confirmed, by full read of the relevant files, to be
pure presentation â€” `StaffShiftPresentation.fromJson` renders whatever
`state`/`homeLabel`/`nextTransitionAt` the server computed, with its own
doc comment stating outright "Flutter does not run the +2h/+6h rules."
No client-side threshold literal exists anywhere in `lib/`; nothing to
change. `Duration(hours: 2)`/`Duration(hours: 6)` occurrences in a couple
of Flutter test *fixtures* are unrelated shift-length/clock-in-offset
scaffolding, confirmed by reading surrounding context, not touched.

**Tests**: `manager-confirmation-timeout-correctness.integration.spec.ts`
rewritten wholesale for the corrected rule (29 tests, all now proving
auto-CONFIRM outcomes, plus two new capacity/double-booking safety tests
matching brief items 14-15) â€” all 29 pass. `shift-cancellation-
correctness.integration.spec.ts`'s `C16`/`C16b` (Phase-7-era tests
asserting the now-superseded reject behaviour) updated to expect
auto-confirm â€” both pass. Post-shift: `staff-shift-presentation.spec.ts`
(12 tests) and `worker-operations-abuse-cases.integration.spec.ts`'s
post-shift-lifecycle block (6 tests) updated for the 1h/2h boundaries â€”
all pass. Phase 2-6 regression suites (worker-event-idempotency 17,
late-clock-in-correctness 25, replacement-staff-workflow 41, shift-
cancellation-correctness 28, same-org-manager-isolation 17, offer-
lifecycle-correctness 26 â€” 154 tests) re-run clean, each in isolation.
`rab-shared`/`rab-server`/`rab-worker` lint clean.

**One real test-authoring bug found and fixed in my own new test**:
`OfferService.sendOne()`'s existing proactive double-booking check (at
SEND time, a real, earlier defence-in-depth layer, unrelated to this
phase) blocked the double-booking safety test's original setup order
outright â€” fixed by sending/accepting the would-be-conflicting offer
BEFORE the other shift is confirmed, so the conflict genuinely arises only
after acceptance, reaching the DEEPER exclusion-constraint check inside
`applyOfferConfirmation` that the test actually intends to prove.

Sporadic `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` lock-timeout noise
recurred under heavy concurrent load during regression runs â€” the same
established, pre-existing environmental pattern every prior phase has
hit on this shared dev database; confirmed by re-running affected suites
in isolation, never touching the same tests twice, never involving
Phase 7.1's own code paths.

No unrelated work touched (account-invite-cleanup/attendance-monitor
batch crowding, MFA, refresh-token rotation, session revocation, backend
caching, image compression, push notifications, general rate-limiter
redesign, geofence security â€” all left exactly as previously reported/
implemented).

Next: Phase 8, or the two now-long-standing batch-crowding defects â€”
user's call.


## 31. Mobile editorial onboarding redesign (2026-09-28)

Latest user scope is the current Flutter Get Started experience only. Replaced
its green placeholder/small black square with three Figma-referenced swipeable
pages in `packages/rab-mobile/lib/features/welcome`: angular reception photo,
serif hospitality collage, and dark/lavender/white/mint bento illustration.
Bundled unchanged user-supplied `hero.jpg`, `frontdesk.jpg`, `bedcleaning.jpg`
under `assets/onboarding/`; registered in pubspec, with bounded decode widths
and precaching. No added dependencies or runtime website asset coupling.

Presentation integration: `AuthBackdrop` now fades the editorial welcome into
the existing black auth band; final login band geometry and sheet choreography
are preserved. `AuthFlowShell` supplies the same `_handleGetStarted` callback.
Get Started on EVERY page still calls `AuthProvider.completeWelcome`, opens the
same login sheet in place, persists the same welcome flag, and preserves the
first-run Back behavior. Swiping does not complete onboarding. No auth provider,
API, session, backend or other mobile-screen behavior changed.

Native motion uses a 700ms stagger, page-offset fade/scale/text-image parallax,
260ms indicators, and 150ms CTA compression/arrow feedback. No idle loops.
Reduced motion renders settled states and removes the extra swipe effects.
Compact layouts reduce whitespace and image/card height; large text reflows to
scrollable content with the CTA retained. Figma example metrics/rate are marked
'Illustrative preview - not live opportunities', never presented as live data.

Verification: Flutter analyze clean; 51 scoped tests pass, covering 18 layout
cases (six sizes x 100/125/200% text, reduced motion at 200%), completion from
first/final pages, persisted flag, Back, login, root-gate isolation, password and
biometric presentation. Android debug APK build passes. All three native pages
visually inspected at 1080x2340/density440 (~393x851 logical) and 880x1562
(320x568 logical) on Pixel_5_2 / emulator-5556; original resolution restored.
Fixed an initial PageController null-page frame, corrected Windows encoding of
currency/labels, tightened the serif headline, and refined compact layouts after
native inspection. Existing unrelated `test/failures/` artifacts preserved.
Actual iOS hardware and frame-rate profiling were not run. No deployment.

Details/commands/file inventory: `packages/rab-mobile/docs/ONBOARDING-REDESIGN.md`.
Generated screenshots: `packages/rab-mobile/build/onboarding-qa/` (ignored build
artifacts); analysis/test/build logs in the same package's `build/` directory.
Next action: user visual review of the installed onboarding on Pixel_5_2; obtain
live-data requirements before replacing the explicitly illustrative bento cards.


### Onboarding visible branding / installed build (2026-09-28)

Changed only the visible welcome literal from RAB / RECRUITMENT to ADOLPHUS / RECRUITMENT; all other source bytes in that edit were preserved. Existing 18 responsive onboarding tests passed. The first branding turn changed source only; this follow-up built and installed the updated normal debug APK on emulator-5556 and visually confirmed the new label. Reset only rab.onboarding.hasSeenWelcome using a temporary ignored QA launcher, then restored the normal main.dart APK; no credentials or other stored data cleared. App left on the updated welcome screen. Evidence: packages/rab-mobile/build/onboarding-qa/branding-updated.png. No backend/app identifier, styling, positioning, animation or navigation changes.


### Onboarding auto-loop and page-boundary fix (2026-09-28)

User explicitly approved the existing design and requested motion/clipping only.
Preserved composition, typography, assets, ADOLPHUS label, spacing and CTA.
Root cause of neighboring-image slivers: content parallax was not clipped at
individual page boundaries (viewportFraction already defaulted to 1). Added
hard-edge ClipRect around each fixed-width page and the PageView; explicitly
set viewportFraction=1. All transforms now remain inside each page's clip.

Welcome uses a cancellable five-second hold Timer, followed by animateToPage
for 900ms/easeInOutCubic. Virtual pages map modulo three, starting at 3000,
so 3-to-1 advances one page smoothly without teleporting or duplicate flashes.
Pages 2/3 slide their content into the unchanged settled positions. Pointer
interaction/scroll start cancels the timer; settling restarts the hold. App
background, reduced motion, disabled ticker and Get Started stop auto movement;
dispose cancels the timer and removes the lifecycle observer. Existing auth
callback and persistence remain unchanged. Earlier 'no loops' documentation
is superseded only by this explicitly requested automatic page progression.

Verification: Flutter analyze clean; 24 existing responsive/onboarding/auth
regressions plus five new timing, touch-pause, clipping, lifecycle and reduced-
motion tests pass (29 total). Debug APK built and installed on emulator-5556.
A 23-second native recording inspected across four transitions, including two
3-to-1 transitions; observed movement windows approximately 0.84-0.93s with
five-second settled holds. No next-page fragments visible at rest. Visuals
otherwise unchanged. Evidence: packages/rab-mobile/build/onboarding-qa/
onboarding-motion.mp4 and motion-contact-sheet.jpg. Device remained running
the normal updated build. No backend, auth, app identifiers or other screens
changed. Next: user review of the installed automatic onboarding experience.


### Onboarding four-second cadence and compact indicator (2026-09-28)

User requested only timing/indicator refinement; this supersedes the earlier
5-second hold / 900ms transition. New total interval=4s, transition=650ms
(easeInOutCubic), hold derived as interval minus transition=3350ms. Retained
one cancellable timer, fresh cycle after manual touch/scroll settles, lifecycle
pause, reduced-motion behavior, modulo-three virtual loop and per-page clipping.
Only Get Started leaves onboarding; auth/session logic remains untouched.

Indicator visual footprint=42px: active18x3, dots4x4, gaps8, radius2, animated
200ms. Kept old header allocation/top-right anchor so branding, page rectangle
and CTA do not move (measured before/after). Pages2/3 now have page-local 400ms,
24px content slide/fade entrances triggered halfway through arrival, with 50ms
hospitality / 60ms bento stagger; shared CTA uses a short upward entrance.
Settled layouts, text, colors, photos, hero clip and Page1 entrance unchanged.

Validation: analysis clean; 31 scoped tests pass incl. exact650ms/four-second
cycle and 42px indicator geometry, existing responsive/swipe/reduced-motion/
auth regressions. Debug APK built/installed on emulator-5556. Inspected 28s
native recording across two full cycles: start-to-start cadence4.003-4.113s;
content completes shortly after page settling, no edge fragments at rest.
Details/commands/limits: packages/rab-mobile/docs/ONBOARDING-TIMING.md. Evidence
under packages/rab-mobile/build/onboarding-qa/onboarding-timing.mp4 and
timing-contact-sheet.jpg. No other app screens/backend/identifiers changed.
Next: user review of the installed four-second onboarding cadence.


### Onboarding to Login vertical handoff (2026-09-28)

Scope: only CTA motion and forward onboarding-to-Login transition. Screen
layouts, assets, typography, identifiers, backend and authentication APIs stay
unchanged. This supersedes the previous shared CTA entrance animation.

Removed the CTA press scale/arrow motion, 150ms callback delay and entrance
wrappers. The stateless InkWell has no splash/highlight/hover visual. Replaced
the welcome backdrop fade plus delayed sheet animation with a 700ms full-page
handoff: Welcome leads upward by 24px over 84ms; the fully assembled Login
then follows from below. Cream fills the transition canvas. The designed black
Login header moves with its white form; it is not an intermediate blank screen.
GlobalKey retains the currently visible carousel page; retained repaint-boundary
children avoid rebuilding the two screens on every animation tick. Duplicate
taps are guarded, the carousel freezes during exit and reduced motion skips
straight to Login. Original completeWelcome persistence runs without gating
animation. Other auth transitions and Back behavior are preserved.

Verification: Flutter analysis clean; all 48 scoped onboarding/layout/motion/
login/navigation/root-gate/password/biometric tests pass. Added pixel-identical
CTA touch regression and intermediate-position checks for both fast and delayed
secure-storage completion. Android debug and normal profile APK builds pass.
Native profile recording on Pixel_5_2/emulator-5556 inspected frame by frame:
current page moves up, complete Login follows, no separate sheet reveal. Debug
recording dropped frames; the emulator disconnected and was restarted. Profile
capture verifies choreography, not a certified frame-rate benchmark. No iOS
hardware/performance measurement was performed.

Evidence: packages/rab-mobile/build/onboarding-qa/handoff-profile.mp4 and
handoff-profile-sheet.jpg (ignored), logs build/handoff-*.log. Used a temporary
ignored launcher to reset only rab.onboarding.hasSeenWelcome; credentials were
not cleared. Restored the normal main.dart profile APK for user review.
Details: packages/rab-mobile/docs/ONBOARDING-LOGIN-TRANSITION.md.
Next action: review the installed Get Started transition on the emulator; use
physical hardware for release frame-rate profiling.


### ADOLPHUS matched-layout auth transition (2026-09-28)

Latest user brief explicitly REPLACES the prior 700ms vertical page handoff.
Read the supplied Ambush recording frame by frame around 3.86?4.23s: glasses
persist/reposition, portrait contracts upward, old labels exit and product cards
appear with overlap. Implemented a 300ms reversible single-Stack composition
(MatchedAuthLayout), not a route slide or separate modal sheet.

Same ADOLPHUS Text element remains mounted and moves beside Back in the Login
header; no fade/recreated brand. Login previously had no brand label, so carrying
this label into the available header space is the minimal continuity addition.
Original typography/layout remain at Welcome rest. Actual images/cards lift a
viewport-derived 80?130px, scale to .91 and crop away; old text/indicator/CTA
exit 20px/fade over 180ms; existing Login groups rise 32px with stagger during
80?300ms. Back reverses the same controller in 300ms. Cream canvas stays fixed;
only actual Login header bounds reveal black. No whole-page opacity/scrim or
page travel. Other authentication transitions and APIs remain unchanged.

Login is laid out offstage before tap, and its real controllers/state persist
across forward/Back cycles. The original completion flag writes asynchronously;
it does not gate motion. Get Started remains static on touch. Autoplay stops
synchronously, in-flight horizontal travel freezes at its current pixels, and
Back resumes cadence only after completion. Hidden controls excluded from focus
and semantics; reduced motion resolves immediately. Added only presentation
options to AuthSheet/LoginSheetContent. A Flexible constraint fixes the existing
Forgot password label overflow at 320px/200% text without changing normal sizing.
No dependencies, backend, credentials, identifiers or unrelated UI edits.

Verification: flutter analyze --no-pub clean; all 52 scoped tests pass (including
pixel-still CTA, immediate/delayed storage, exact brand element identity, frozen
page, persistent Login state, 300ms reversal, reduced motion, intermediate
320x568/393x851/844x390 at 200% text, existing Login/auth/password/biometric/root
routing). Normal main.dart profile APK builds and is installed on emulator-5556.
Native forward and Back inspected frame by frame; initial title/photo overlap
was corrected by painting the actual visual above incoming fields, then recorded
again on the FINAL normal build. App left on onboarding. Only the onboarding
completion flag was reset via an ignored temporary helper; credentials untouched.

Evidence (ignored): packages/rab-mobile/build/onboarding-qa/
matched-auth-final.mp4, matched-auth-final-sheet.jpg, ambush-morph-frames.jpg.
Logs: build/matched-tests.log, matched-analyze.log, matched-normal-build.log.
Full requested report: packages/rab-mobile/docs/ONBOARDING-LOGIN-TRANSITION.md
(rewritten to supersede the old vertical-handoff report). No physical-device
60fps benchmark or iOS validation; those are not claimed. No deployment.
Next: user review of the installed fast forward/Back morph; physical-device
frame profiling before a release performance claim.


### Full onboarding scene transition correction (2026-09-28)

User reviewed the matched-layout recording and explicitly corrected the hierarchy:
ENTIRE onboarding page must translate upward, with image morph only secondary.
This supersedes the preceding image-led morph and separate copy/brand exits.

MatchedAuthLayout now retains two complete opaque scenes in one Stack. Welcome
moves 0 to -viewportHeight; complete Login moves viewportHeight to 0. Both share
one 300ms easeInOutCubic travel value, keeping Login top exactly equal to Welcome
bottom at every frame and on reversal. Synchronized motion intentionally replaces
a separately delayed Login curve to prevent any exposed gap. Brand, indicators,
all headings/copy and CTA have the identical parent displacement, with no local
fade/flight. Images/cards alone add a subtle .97 scale and viewport-relative lift
(capped at 24px). Removed the prior crop-away and secondary-content fade.

Login's existing header/form are fully assembled and travel together. The brand
travels out with onboarding instead of relocating into Login's header; original
Login composition restored. No independent button motion, scrim, full-page fade,
new route, backend or authentication API changes. Retained prelayout, controller
state across Back, timer cancellation/freeze, focus protection and reduced motion.

Validation: all 52 scoped tests pass, now including identical brand/indicator/
heading/CTA displacement and the shared page boundary at mid-transition. Analysis
clean; normal main.dart profile APK builds and is installed on emulator-5556.
Native forward/Back recording inspected: full-page upward movement and complete
Login entry confirmed, no blank transition gap. Evidence (ignored): mobile
build/onboarding-qa/full-scene-auth.mp4 and full-scene-auth-sheet.jpg. Logs:
build/scene-tests.log, scene-analyze.log, scene-normal-build.log. Capture occurred
while the standard build was compiling, so it is choreography evidence, not a
frame-rate benchmark. No physical-device 60fps claim or iOS check.

Used ignored helper to reset only onboarding completion, then restored normal
main.dart profile APK and left onboarding open. Credentials untouched. Updated
packages/rab-mobile/docs/ONBOARDING-LOGIN-TRANSITION.md to the current design.
Next: user review of the installed whole-scene transition. Prior uncommitted
work preserved; no production deployment.


### Accelerating Get Started / complementary Back timing (2026-09-28)

Latest request changes ONLY timing/curves of the existing full-scene transition.
Old controller was 300ms/easeInOutCubic; its concentrated middle travel made the
visible change feel abrupt. Now one 450ms controller drives easeInCubic forward.
Back is 450ms/easeOutCubic in elapsed reverse time: because controller value
runs 1 to 0, scene position uses 1 - easeOutCubic(1 - value). Both scenes derive
identical curved travel and retain their continuously touching page boundary.
No additional phase, route, timer or independently animated page added.

Unchanged: complete onboarding parent movement, small local image/card effect,
static CTA touch response, UI styles, horizontal autoplay, indicators, Login
functionality, persistence, navigation and backend. Source edits limited to
onboarding_auth_motion.dart, matched_auth_layout.dart, a shell comment, timing
regressions and docs. Previous uncommitted work preserved.

Verification: Flutter analysis clean; all 53 scoped tests pass. Added exact
75ms scene-offset sampling: forward distance percentages 0/2.17/6.25/14.53/
31.56/61.16/100; Back 0/43.63/72.26/87.51/95.40/99.01/100. Each forward interval
travels farther, each Back interval less; both page edges remain joined. Existing
static-button, whole-scene displacement, state retention, reduced-motion,
responsive/accessibility and auth/navigation tests remain green.

Android profile build recorded with no concurrent build; inspected native
forward and Back plus nearest available frames at requested 0/75/150/225/300/
375/450ms points. Original capture is variable rate; a fixed 30fps review export
holds source frames rather than inventing motion. Evidence under mobile
build/onboarding-qa/: accelerating-auth-raw.mp4, accelerating-auth-30fps.mp4,
accelerating-75ms-review.jpg. Exact 75ms values above come from widget-rendered
positions, not a fabricated native frame-rate claim. No physical-device or iOS
performance certification.

Normal main.dart profile build passes and is restored to emulator-5556. Only
onboarding completion was reset with the temporary ignored helper; credentials
untouched. Report updated at packages/rab-mobile/docs/ONBOARDING-LOGIN-TRANSITION.md
with all requested headings and measurements. Logs: build/accelerating-tests.log,
accelerating-analyze.log, accelerating-normal-build.log. No deployment.
Next: user review of the installed 450ms accelerating forward and settling Back.


## Staff Calendar visual upgrade (2026-09-28)

Replaced only Staff Calendar presentation with the compact reference direction:
month/profile header, animated Today/Month pill, custom seven-column month card,
green selection, tiny status dots, selected-day summary and pastel shift cards.
New calendar_view.dart and calendar_presentation.dart keep provider/API actions in
calendar_screen.dart. Shared ScheduleCalendar (Venue Manager), AppShell, bottom
navigation, Home, History, auth and backend remain unchanged by this task.

Production uses existing offers and stable ShiftVisualStyle identities. Confirmed
plus pending/staff-accepted offers appear; server presentation wins over fallback
raw status/attendance. No lifecycle timing is calculated by Calendar. Date grouping
preserves existing device-local overlap and midnight boundary behavior. Payload has
no organisation timezone: do not claim timezone normalization was implemented.
Today now means today's entries per the brief, replacing the old weekly agenda.
Month starts selected, previous/next selects first day; picker retains old bounds.

Verification: regression run 44 passed; latest dedicated Calendar suite 12 passed.
Rendered screenshots inspected at 320x640, 364x661, 393x852, 430x932 and 200% text.
Visual inspection caught clipped two-digit dates at 200% and fixed them; enlarged
month labels abbreviate. Fixtures are test-only, not live account records.
Normal and reduced-motion layout/behavior checks pass. Logs and images under
packages/rab-mobile/build/calendar-*.log and build/calendar-qa/. Full report:
packages/rab-mobile/docs/CALENDAR-UI-UPGRADE.md. No credentials or account resets.
Next: review the redesigned Calendar on an authenticated staff account with real
offers; organisation-timezone payload support remains outside this UI scope.

Final verification: flutter analyze reports no issues; normal main.dart Android
profile APK build passes. Installed successfully with adb install -r on
emulator-5556 and launched MainActivity; app data/auth credentials not reset.


## Internal Manager Select Staff flow (2026-09-28)

Implemented full main-workspace StaffSelectionPage from ShiftApprovalDrawer in
rab-front, preserving sidebar and existing Users/admin routes. Footer is Decline /
Select N Staff (disabled Staff Complete at capacity) / Approve. Picker stages a Set
of IDs, preloads persisted recipients, searches active staff server-side, enforces
capacity, and discards drafts on Cancel. Confirm saves only; Approve separately
uses persisted recipients. Existing partial staffing/partial-send rules preserved.

Minimal API support: ListStaffDto.accountStatus and list predicate; validated PUT
/shifts/:id/requested-staff with desired and expected prior IDs. Atomic save checks
service permission, org/workspace, staff createdBy ownership, account+employment
ACTIVE, existing availability, capacity and optimistic concurrency. Reuses existing
per-person audit/VM removal notification, never sends offers or notifies staff.
Save/add/remove/approve/decline serialize on the parent shift. Legacy add now guards
capacity; approval now rechecks ACTIVE employment alongside existing account check.
No RLS/state machine/auth/worker/mobile/payroll changes. Existing dirty work retained.

Verification: 100 frontend tests; final targeted 14 pass. Real local Postgres/RLS:
27 Venue Manager/selection, 45 offer/ownership, 58 replacement/same-org isolation
checks all pass. Both packages' TypeScript lint checks pass; Vite production build
passes with existing large-chunk warning. Chromium full-shell fixture QA inspected
at 1366x900,1440x900,1920x900 including settled drawer, empty/loading/error/retry and
separate Confirm/Approve. No page errors or body overflow. Browser uses synthetic
fixtures; HTTP integration tests separately prove real database behavior. Remote
.env database was not used. Test email driver LOGGER; fixture/audit rows retained.

Full file inventory, decisions and evidence: docs/INTERNAL-MANAGER-STAFF-SELECTION.md.
QA scripts/screenshots/logs: .audit/select-staff/. THREAT-MODEL.md updated.
No deployment. Current rab-server-1 has no source mount, so its built API is still
old. Next: release the reviewed web+API changes together (filter/PUT required),
then review a real pending request as Internal Manager. No migrations needed; do
not rebuild/deploy unrelated dirty Phase 1-8 work without reviewing that scope.


## Internal Manager Select Staff loading fix (2026-09-28)

Reproduced real browser GET /staff with accountStatus=active returning 400:
property accountStatus should not exist. Frontend source was newer than the
compiled local API image. Replaced picker data source with shift-scoped
GET /shifts/:id/selectable-staff: manager application, STAFF_VIEW + approval
permission, pending VM request, authenticated org/workspace and createdBy owner,
SQL ACTIVE account + employment, minimal projection, real search/pagination.
Canonical availability uses stored shift times; busy active rows are disabled,
and requested-staff drawer shows availability. Confirm/Approve remain separate.
No UI redesign or VM directory/RLS/auth/mobile/lifecycle changes in this fix.

Verification: 30 real Postgres integration tests; 103 frontend tests (17 focused);
both TypeScript/lint checks; normal API image compilation all pass. Actual browser
against running API verified search, paging, Retry, preselection, Confirm with
zero offers and Approve sending exactly one offer to the final saved recipient.
Screenshots reviewed at 1366/1440/1920 widths without body overflow.

Local API updated after healthy canary and selector HTTP 200, image
rab-select-staff-api:local. rab-server-1 healthy on 3000, worker unchanged,
no migrations/bootstrap; environment preserved. Prior no-deployment note is now
superseded locally. Build includes current dirty workspace source; do not promote
as an isolated production patch without reviewing unrelated pending changes.
Exact four synthetic QA accounts secured, QA shift cancelled, sessions revoked;
audit history preserved and temporary private files removed. Initial broad cleanup
was rejected by automatic review; verified exact-identity cleanup succeeded.

Report: docs/INTERNAL-MANAGER-SELECT-STAFF-LOAD-FIX.md. Evidence:
.audit/select-staff-load/. No known remaining selector load issue. Next: reload
local UI and review a real pending request; production release is not performed.


## Venue Offer live staffing Kanban (2026-09-29)

Completed the requested desktop post-approval pipeline using existing domain
services. Pending/declined requests retain ShiftApprovalDrawer; approved rows and
successful Approve open /venue-offers/:shiftId. Exact seven presentation columns,
no drag, server-derived table vocabulary/counters/cancellation/replacement/report
readiness, React Query 5-second board polling and 10-second list polling. WAITING
means persisted offer_sent notification.read_at, not delivery/offer-view telemetry.
Phase 3 late predicate is shared; attendance facts override late/terminal cards.

Manager cancellation uses strict DB time < start minus 15 minutes, parent-first
locks and current offer/assignment/attendance checks. Preserves confirmed offer
history, releases a seat once, reuses optional UserNoteService, audit and existing
notification, and existing staff-mobile cancelled projection. Replacement uses the
same StaffSelectionPage, active private selector, canonical availability,
OfferService and ReplacementRequestService; no random automatic send. Existing
shift state transitions now permit reopening staffing after individual cancellation.

Existing ShiftReportService is batched (removed per-assignment reads) and supplies
real avatar IDs/attendance/finaliser/readiness. Existing final-timesheet worker and
template now also store an immutable unsigned original in original_file_id; the
existing final_file_id remains the VM-finalised version. pre_shift_file_id is still
a roster. No handwriting capture exists; finalisedBy/At are the existing sign-off.
Both files retain existing FileService/StoredFile/ReportFilePolicy authorization.
Preview batch endpoint accepts <=32 opaque image IDs, existing RLS/image policy,
verified <=2 MB inline bytes per image with initials fallback and no-store headers.
Report/cancel drawers portal to the existing app-layout dock, not inside the page.

Verification: 25 projection unit tests; 37 scoped Postgres pipeline/selector tests;
109 frontend tests (15 suites); 39 storage/security tests incl batch previews;
41 attendance abuse tests; 42-step real attendance/VM report walkthrough;
66 existing late/replacement regressions; 28 cancellation regressions;
21 report concurrency/multiworker regressions. Server/front/worker TypeScript lint
checks exit 0. Shared/API/worker compilation, final Docker image and Vite production
build pass. Existing Vite large-chunk, Redis 5 recommendation and ts-jest deprecation
warnings remain. Old regression fixtures now explicitly activate employment.
Local scheduler was paused for deterministic race checks, then resumed on new image.

Real Chromium with local API/Postgres/MinIO verified approval/direct reopen,
cancellation+saved Notes, replacement, notification-read/accept/decline/late/
clock-in/out polling, avatar and original/final PDF downloads, reload reconstruction.
Final screenshots reviewed at 1024/1440/1920 with no page overflow or page errors.
Existing desktop shell phone layout/mobile app UI was not redesigned.

Local ONLY: additive migration 1786673700000-OriginalTimesheetFile applied through
the isolated local migration runner. API rab-server-1 and worker rab-worker-1 use
rab-venue-pipeline:local (final image sha256:ed8867b8d326c116f9bde32768bd40060ed6beb16a232a549a747cea5348a0a9).
API healthy on 3000, Vite on 5173, worker running, existing LOGGER email configuration
preserved. No remote .env database used, no production deployment. Both runtime
images include existing dirty workspace source; do not promote wholesale without
reviewing unrelated pending changes. Production order: migration, API+worker, web.

Five exact synthetic browser accounts suspended, password material cleared and
refresh sessions revoked. No pending offers or unresolved attendance remain on the
QA shift. Its cancellation guard returned 409 after the lifecycle finished; no
forced state change was used. Audit/report/notes preserved; private QA credentials
and container snapshots removed. General integration fixture history remains local.

Full 30-section report: docs/VENUE-OFFER-LIVE-STAFFING-KANBAN.md.
Initial audit: docs/VENUE-OFFER-KANBAN-AUDIT.md. Security: THREAT-MODEL.md.
Evidence: .audit/venue-pipeline/ (final-checks.json, integration.log,
frontend-tests-final.log, file-storage-security.log, attendance-lifecycle.log,
cancellation-regressions.log, report-regressions.log, browser-*.json,
report-signed.png, staff-notes.png, board-1024/1440/1920.png).
No known remaining implementation issue within requested desktop pipeline scope.
Next: reload local Venue Offers and open an approved request; separately review and
release the migration/API/worker/web together if production deployment is requested.


## Venue Manager / Staff Calendar consistency (2026-09-29)

Latest mobile presentation-only task supersedes the earlier Staff-calendar note
that shared ScheduleCalendar was unchanged. Staff had acquired a private layout;
Venue still used the older weekly/stock-picker layout. Extracted the approved Staff
layout into core/widgets/schedule_calendar.dart, with role-neutral entries/status,
legend, empty copy, summary noun and refresh/profile callbacks. StaffCalendarView
is now a thin adapter; its approved shift card remains intact. Shared calendar
colors/status labels live in core/theme/calendar_tokens.dart and reuse ScheduleTokens.

Venue adapter preserves its scoped provider, cancelled exclusion, detail/profile
navigation, joined/required/team records and ShiftVisualStyle.forShift identity.
Adds real event time/status text; maps actual server shift states without treating
partial staffing as confirmation. Both roles share header, Today/Month pill, month
grid, selection, dots, empty surface and motion. Long legends wrap at 200% text.
Summary totals scheduled durations, not attendance/payroll, with proper plurals.
Local-time overlap remains unchanged. Shells and MovingTabBar remain unchanged;
Venue retains Home/Calendar/Offers/Profile. No backend/API/auth/lifecycle changes.

Verification: flutter analyze --no-pub clean; 82 scoped calendar/venue/navigation/
color tests pass. Direct role geometry and content checks at 320x640,393x852,
430x932,390x844 with 100%/200% text; reduced motion covered. Native profile preview
of production role widgets on emulator-5556 inspected side by side for Month,
Today, populated/empty dates and month navigation. Synthetic data only, no login
or stored-data changes. Inspected all 33 variable-rate native recording frames;
no frame-rate certification or physical iOS test claimed. Normal main.dart profile
APK builds and was restored via install -r and launched; credentials not cleared.

Report/files/commands/limits: packages/rab-mobile/docs/VENUE-CALENDAR-CONSISTENCY.md.
Evidence: packages/rab-mobile/build/venue-calendar-qa/ (native-comparison.jpg,
role/mode screenshots, motion.mp4, motion-review.jpg); build/venue-calendar-final-tests.log,
venue-calendar-analyze.log, venue-calendar-normal-build.log. Existing uncommitted
work preserved. No production deployment. Next: review a real authenticated Venue
Manager Calendar, then distribute through the normal mobile release process.


## Existing auth UI / four Figma states (2026-09-29)

Updated existing AuthFlowShell/LoginSheetContent/BiometricLockSheetContent and
AuthSheet to the supplied four-state Figma: black upper region, stable white
32px-radius sign-in sheet, shared Welcome back block, compact biometric tile,
inset fields/black buttons and footer. No new screen/route/provider/dependency.
AuthSheetGeometry uses 31% usable height for sign-in; other setup/reset sheets
retain prior ratio. Onboarding design/timing, Calendar and backend unchanged.

Returning biometric screen probes only on mount; explicit Continue invokes the
existing local_auth method. Ready/busy/failed are local UI flags; ordinary failure
only changes to Try again, lockout gets small inline copy, unavailable uses existing
password fallback. Shell password-fallback mode retains provider biometricLocked
and the same mounted Login form, supports return to Ready, and is cleared whenever
the provider leaves that gate. Normal/reauth login cannot expose a biometric action.
Core AuthProvider/authenticator/store, session validation, role routing, logout,
reauth window and token storage untouched. No pre-unlock verified email exists:
read-only Saved account rather than invented data/new persistence. Description and
footer truthfully describe device biometrics; requested passkey title remains
product copy, not WebAuthn/security-key support. Normal footer uses the brief's
preferred corrected English. THREAT-MODEL.md records these boundaries.

AuthContentLayout in existing rab_auth_sheet.dart replaces intrinsic-height
estimation (which clipped narrow copy at large text) with natural scrolling and
low footer. Same password validation/errors/cooldown/eye/Forgot password reused.
No real passwords, credentials or account data used in QA artifacts.

Verification: flutter analyze --no-pub clean; all 110 existing/extended auth,
biometric, login, password, root-gate, onboarding and navigation tests pass.
Four phone sizes at 100%/200% text; keyboard at 320x568/200% tested. Both role routes,
server denial after biometric success, mandatory reauth, duplicate prevention and
form/shell identity covered. Native Pixel_5_2 profile preview uses production UI
and real OS biometric plugin with in-memory fixture session. Compared four states,
cancel/retry/fallback/return, normal login and forgot password. OS prompt focused
and verified by Android UI hierarchy; ADB capture was black, so no visible prompt
screenshot claim. Full software keyboard checked on restored normal app with empty
fields: password visible and Sign In reachable by scrolling. Emulator keyboard
setting restored; normal main.dart profile APK built, installed and launched;
app data never cleared. No iOS hardware or production deployment claim.

Report: packages/rab-mobile/docs/EXISTING-AUTH-UI-FIGMA-UPDATE.md (20 sections).
Evidence: packages/rab-mobile/build/auth-figma-qa/ (four-state-comparison.jpg,
software-keyboard-submit.png, native-prompt.xml/native-retry.xml and state captures).
Logs: build/auth-figma-tests-final.log, auth-figma-analyze-final.log,
auth-figma-normal-build.log. No known implementation issue remaining in UI scope.
Next: user review of installed sign-in; distribute via normal mobile release process.


## Existing-account biometric persistence / 90-day trust (2026-09-29)

Updated existing mobile AuthProvider, BiometricStore and ApiClient; reused all auth screens and native local_auth adapter. Remembered verified user ID/email and biometric preference survive normal logout; tokens, session owner and CurrentUser do not. Biometric lock requires tokens, matching session/remembered/preference IDs, usable device biometrics and a native confirmation strictly younger than the single 90-day constant. Unlock checks ownership/deadline before/after native/backend work. Password login/unlock never extend confirmation; expired trust requires password and existing setup/native confirmation again. Same-account password login within a valid cycle automatically rearms; different accounts cannot inherit trust. Skip/failed setup leaves biometrics inactive. Explicit disable clears preference+confirmation. Login email prefills; biometric email is real and read-only. Layout/navigation/auth role gates preserved.

Legacy records intentionally require password+fresh setup once (no reliable previous native confirmation date). /auth/me now refreshes expired access; logout refreshes and revokes the rotated token. Transient refresh/validation failures retain retryable session/preference. Logout prevents late native success from restoring user state; API refresh checks token-generation invalidation. Initial restore waits for cleanup before its final state notification. No backend or app identifiers changed.

Verification: 140 auth/navigation-related tests passed, flutter analyze clean, Android profile build passed. Tests include exact 90-day microsecond boundaries, clock movement during prompt, logout/relogin, cross-account denial, revocation, transient errors, skip/failure, forced reset, readonly/prefilled email and responsive UI. Report: packages/rab-mobile/docs/BIOMETRIC-PERSISTENCE.md; threat model updated. Ignored logs under mobile/build/biometric-persistence-*.

Limits: local_auth cannot reliably identify enrollment-set changes; only supported availability signals used. General app-resume relocking remains unchanged. Offline server revocation cannot be guaranteed; local logout cleanup is bounded to 10 seconds. Next action: physical-device password login/native setup and real backend lifecycle smoke test with an authorized account. Do not invent/migrate native confirmation from the old lastFullAuthenticationAt timestamp.

Android smoke check: final profile APK installed successfully on emulator-5556 without clearing app data; launched com.rab.rab_staff/.MainActivity. UI hierarchy confirms Welcome back / Sign in to your account / Sign In, with no biometric-unlock button. No real credentials entered.


## Biometric setup reference UI (2026-09-29)

Updated the existing BiometricSetupSheetContent in the same AuthFlowShell/AuthSheet. Removed large green hero/pill actions. Setup-specific sheet geometry uses rounded 28px top corners, 40px normal top padding (24px compact), the shared sign-in vertical region and natural-height scroll content. Reused AuthWelcomeHeading (optional title/type sizes), AuthPrimaryButton (optional radius), AuthContentLayout and truthful biometric footer. Added 80px outlined circle/46px grey tile using existing biometricIcon. Exact requested title/setup heading/button wording; no new routes/providers/packages or passkey system.

Small requested behavior integration: completeBiometricSetup now advances only for successful native confirmation or explicit Skip. Failed/cancelled/unavailable results remain on the same setup screen, with inline message and retry/Skip; this supersedes the previous entry's failure-auto-continue behavior. Busy actions are guarded. Loss of capability before the screen mounts follows existing explicit-skip call. Trust timestamps, remembered identity, logout, session and role rules otherwise untouched.

Verification so far: 158 auth/navigation tests passed, including four viewport sizes at 100/200 percent text, same mounted shell/no pushed route after failure, native-result binding assertions and Staff/VM destinations. Native Android fixture uses real local_auth and production shell/provider with synthetic in-memory HTTP/storage (build/setup-figma-qa/main.dart, ignored). Captured initial screen, native prompt hierarchy, cancellation/inline retry and Skip. Skip logged authenticated with binding=false. Normal emulator fingerprint touch IDs tested were rejected; successful native confirmation remains unverified on this emulator (automated success tests pass). Native prompt PNG is black because OS capture excludes that surface; XML proves actual prompt. Never label unmatched prompt evidence as success. Report: packages/rab-mobile/docs/BIOMETRIC-SETUP-FIGMA-UPDATE.md. Restore normal main.dart profile APK after QA; do not leave fixture installed.

Setup UI final checks: flutter analyze clean; normal main.dart profile APK build passed and restored to emulator-5556 with app data preserved. Final report records native-success verification as pending; do not claim full QA completion. Initial native screenshot predates punctuation-only em-dash correction.


## Venue Manager History navigation (2026-09-29)

Root cause: VenueManagerShell index 2 explicitly rendered VenueOffersScreen -> VenueSentShiftsScreen with Offers semantics. Now Home | Calendar | History | Profile; index 2 renders a small VenueHistoryScreen in the existing screens module, using VmPage/VmData/ScheduleRecordCard and VenueEventDetail. Home My Space -> Sent offers still opens the unchanged VenueOffersScreen/VenueSentShiftsScreen. Shared MovingTabBar uses a document/history icon in the third schedule-style slot (also correcting Staff's history glyph); geometry and Staff destinations unchanged.

VenueManagerProvider.history filters existing server-scoped events by end <= current time and completed, or confirmed/fully_filled/partially_filled with filledCount > 0. Excludes future shifts, draft/request/open/offered/cancelled/declined/in-progress records. Past end time does not invent a completed status. Most recent end first; shows venue/role/date/scheduled time/joined count, current backend status and confirmed names. Existing detail/report access remains server-authorized. No new endpoint, scope selector or Staff-history data source.

Kept IndexedStack, four nested Navigator keys, selected-tab NavigatorPopHandler, re-tap pop-to-root and refresh behavior unchanged. History has PageStorageKey for list position. Verification: 68 venue/shared-nav/root-gate/calendar regressions passed; explicit detail/tab/back/re-tap and scroll-position checks passed; flutter analyze clean. Existing stale Log in test expectations updated to current Sign In copy. Production backend and unrelated mobile work untouched. Local QA evidence was intentionally removed from source control.

Android verification: normal profile APK build passed and installed/launched successfully on emulator-5556 without clearing app data. Visual History verification used scoped widget-test fixtures; no live user credentials were entered. Scoped git diff --check passed.


## Production-readiness audit evidence (2026-09-29)

Audit-only request; no application remediation was authorized or implemented. Preserve the extensive pre-existing dirty tree. Primary report: `.audit/ultimate-readiness-2026-09-29/REPORT.md`; evidence index: `TEST_RESULTS.md`; machine-readable findings: `findings.json`. These are ignored local artifacts; retain them separately if sharing or committing the audit. Documentation pointer: `docs/security/ULTIMATE-READINESS-AUDIT-2026-09-29.md`.

Report contains 90 requested sections, all 75 handbook categories, 36 System Issues rows, 25 final answers and 17 findings (SEC-001 through SEC-017, with descriptive IDs). Status is PARTIAL audit coverage; definitive production certification was not achieved. Important findings: controlled concurrent refresh double-consumption; access JWT remains valid after logout/family expiry; mobile foreground/resume biometric deadline and profile-renewal policy gaps; installed affected multipart parser; Users loading render loop; Venue Offers status filter ignored; eligibility/routing/bounds/fairness drift. Recommendations only, no fixes.

Fresh verification: uncached shared/server/worker/frontend builds and TypeScript lint targets passed; Flutter analyze passed. React 109/109, shared 58/58, worker normal suites 270/270, API storage 51/51, worker report-storage 13/13. Consolidated unique server cases 618/619 after correcting disposable timeout/email fixtures. Flutter 357 passed, 11 failed (ten golden comparisons, stale RAB assertion). Remaining server dashboard fixture conflicts with current creator-plus-workspace ownership; do not weaken access control to satisfy it. Open Jest handles required forceExit, so shutdown is not proven. RLS checker passed 35 tenant tables as rab_app; fresh migrations passed.

Browser evidence: Users delayed-response loop and Venue Offers tab issue reproduced. Eleven routes exercised through real Nest handlers and synthetic database fixtures; Dashboard requested /managers twice and correctly received 403, other checked pages had no console errors. This interception-based smoke does not certify cookie/CORS transport or populated drawers/Kanban. Auth probe uses a controlled in-memory read barrier; source files were not patched. Worker report-storage tests use two Nest instances in one process, local MinIO and a local SMTP sink, not real OS-process termination or external email.

Safety: isolated loopback PostgreSQL/Redis/MinIO only, synthetic fixtures, LOGGER or local SMTP, no real email/payroll/attendance/storage effects. Audit Vite on 5179 and four explicitly named rab-audit-20260929 containers were stopped after verification; containers/data retained. Existing app services untouched. No credentials or tokens are recorded here.

Remaining evidence: Strix CLI/model configuration unavailable (no scan claimed); full 157-endpoint/11-layer policy map incomplete; production firewall/TLS/R2/backups/restore/rollback/CI/image and secret-history scans unverified; no native physical-device/iOS/biometric run, representative load/soak/fairness benchmark or clean-checkout release. Next action: review the evidence and approve a specific remediation phase before changing code; roadmap phases 10-15 are recommendations, not authorization.


## Venue Manager individual assignment windows (2026-09-30)

Approved scope extension implemented on the existing flow. Mobile hides bottom navigation on pushed workflows, removes notes/pay/More options, uses one assignment draft map, preserves custom times across picker visits and renders editable selected-staff cards. Shared break, full-date overnight validation, disabled invalid submit and narrow/large-text layout included. Existing Users plus opens authorized All Users/add-to-team; no separate mobile create-account form was found or invented.

Canonical approved schedule is existing ShiftAssignment.period. New nullable ShiftRequestStaff starts_at/ends_at migration 1786674200000 persists pre-approval intent. Manager review displays times; approval/bulk offers preserve them. Central effectiveAssignmentTime/assignmentTimeSql used by offer projection/pay, attendance admission, late/reminder/no-show/missing-clock-out and report/timesheet scheduled fields. Parent QR/lifecycle/report scheduling and cancellation remain unchanged. Missing-clock-out exact end filtering occurs in workspace-scoped transactions with assignment RLS active; rejected RLS-disable proposal was never applied.

Verification: 47 Flutter tests and clean analyze, 139 focused server tests, 222 worker tests, 37 manager UI tests, server lint, four-package build, normal Android profile APK build, migration upgrade and transactional down/up passed. Final expanded propagation/monitor checks are still being recorded in docs/VENUE-MANAGER-ASSIGNMENT-TIMES.md; consult its final verification update before calling complete. Tests use dedicated disposable loopback DB/Redis and local storage/email sinks. Widget captures inspected; no physical-device authenticated QA or production deployment claimed. Existing unrelated dirty work preserved. Next action: finish final checks, update report/handoff, then use normal coordinated migration/server/worker/mobile release process.


### Assignment-time final verification and blocking condition (2026-09-30)

Final expanded server propagation assertions passed: 139 tests / five suites (`.audit/venue-assignment-times/server-final.log`). Flutter 47, frontend 37, worker regression 222, clean analyze/server lint, final four-package build and normal Android profile build passed. Fresh empty-database migration chain now also passed after standard core-schema bootstrap; transactional down/up kept request-table RLS enabled+forced. Explicit tests cover overnight offer/pay/overlap/report propagation, later individual clock-in admission, late-clock timing and earlier individual missing-clock-out while parent continues.

A targeted worker run reported 61 passing tests, but its evidence file was interleaved by the child of an earlier interrupted server runner. A clean final rerun was rejected twice by automatic approval review because it executes the pre-existing attendance/shift RLS-disable discovery path, even in verified disposable audit containers. Snapshot comparison proves those statements are unchanged; no new assignment RLS-disable path exists. Do not bypass the rejection or redesign discovery just to evade it. Next action requires user approval for this exact isolated regression rerun; then run `.audit/venue-assignment-times/run.py worker-monitor-final` and record clean results. Do not declare fully verified before that. Report: docs/VENUE-MANAGER-ASSIGNMENT-TIMES.md (42 requested sections plus propagation/evidence). No production deployment or physical-device authenticated QA performed.


## Venue Manager Calendar Figma restoration (2026-09-30)

Restored presentation through optional ScheduleCalendar.agendaStyle, enabled only by VenueCalendarScreen. Today now has a seven-day black-selected-tile strip, left date rail, whitespace for empty dates and mint/peach existing ScheduleRecordCards. Compact 22px header/44px profile target. Existing Month grid/controls, Staff default presentation, root floating nav and nested-route hidden nav retained. Display authorized payRatePence when present; otherwise existing staffing metric. Existing confirmed team/avatar stack retained, with truthful zero-team wording. Times/status retained as supporting text.

No backend/provider/auth/permissions/RLS/eligibility changes. Current provider fetches scoped pages of 100 until total; no per-day requests or range expansion. Existing toLocal/day-overlap grouping remains, including cross-midnight on both overlapping dates and exclusive midnight end. Individual assignment-time propagation untouched.

Verification: 72 tests passed across restored agenda, shared Staff calendar, Venue calendar and Venue Manager navigation; flutter analyze clean. New 390x844 golden inspected against reference and verified; native Android emulator-5554 in-memory fixture Today/Month inspected. Fixtures exist only under test/ and ignored build/calendar-restoration-qa; never ship fixture main. Native screenshots precede punctuation-only status separator fix; final golden has corrected middle dot. Normal build/restoration is being finalized; see next entry before assuming fixture removed. Report: packages/rab-mobile/docs/VENUE-CALENDAR-FIGMA-RESTORATION.md. Evidence: .audit/venue-calendar-restoration/. Prior worker rerun block is unrelated and remains unchanged.

### Calendar restoration final device verification (2026-09-30)

Normal lib/main.dart Android profile build passed, then was installed and launched on emulator-5554 without clearing app data. The retained real session opened Calendar successfully; Today/Month controls and week-date accessibility semantics were verified. The normal app is running, not the in-memory visual fixture. Evidence: .audit/venue-calendar-restoration/android-normal-build.log and normal-calendar-ui.xml. Final verification remains 72 passing Flutter tests, clean analyze, inspected golden and native Today/Month captures. No backend changes or production deployment in this task. Intentional visual differences and physical iOS QA limitation are documented in packages/rab-mobile/docs/VENUE-CALENDAR-FIGMA-RESTORATION.md. Next action: review the restored Calendar in the running emulator; physical-device QA before release.

## Staff Calendar agenda parity (2026-09-30)

User requested the restored Venue Manager week strip and dated agenda on Staff too. StaffCalendarView now enables the existing ScheduleCalendar.agendaStyle; Today is the initial mode for both roles. Existing Staff cards, pay/time/status semantics, shift colours, provider, detail callbacks, Month mode and navigation are unchanged. No backend changes. Updated calendar tests to explicitly select Month where needed and assert Staff default week strip, with equal compact role geometry. Verification: 27 focused calendar tests passed; flutter analyze clean; normal Android profile APK build passed. Staff 393x852 agenda capture inspected (build/calendar-qa/today-single-393x852.png). Updated normal app installed on connected emulator-5554 without clearing data and launched. No physical phone connected; no physical-device or production deployment claim. Next: review Staff Calendar in the updated app; physical-device release QA remains separate.

## Mobile cold-launch app lock (2026-09-30)

Root cause: absent biometric binding led _init to _restore, whose successful /auth/me response selected authenticated without local presence. Added process-only AppUnlockState (default locked); canAccessAuthenticatedUi requires valid loaded identity, authenticated phase and unlocked. Password login grants current-process unlock through the canonical flow; biometric unlock still requires native success plus server/binding/deadline validation. Non-biometric restored sessions now require password. Skip unlocks the password-authenticated current process, never future processes. No kill callback, persistent unlocked flag, new endpoint or server change. Authenticated providers/root and navigator lifetime use the combined gate; pushed sensitive routes are discarded when access is lost. Returning locked users skip first-ever welcome animation even with a missing legacy welcome flag.

Verification: complete Flutter suite 381 passed; flutter analyze clean after two brace-only lint fixes; normal Android profile APK built and installed. Real emulator force-stop/restart with app data retained showed password/Sign In/security message and no authenticated Calendar navigation. Full native login-Skip-restart-password and native biometric enable/cancel cycles were not performed. Existing mock tests cover auth/biometric/deadline/role scenarios; new tests cover two process instances, wrong password, offline retry and cold named routes. Old tests explicitly expecting automatic unlocked cold restore now require password; role tests log in before asserting shells. Unrelated dirty work preserved.

Important source discrepancy: current ApiClient still persists rab.accessToken using FlutterSecureStorage, contrary to the brief's memory-only claim. Existing token storage was not rewritten or certified in this local-lock fix. No claim of server Phase 10 validation from mobile tests. Report: packages/rab-mobile/docs/MOBILE-COLD-LAUNCH-APP-LOCK.md (22 requested sections). Evidence: .audit/cold-launch-lock/. Next: authorized native password/Skip and biometric enable/cancel end-to-end QA; separately review token-storage policy before release. No production deployment.

## Venue Send Shift assignment breaks / DTO / success sheet (2026-09-30)

User explicitly replaced containment with default times. StaffAssignmentDraft and server validateAssignmentTime now allow intervals outside defaults, preserving positive duration and break validation. Optional per-staff break null inherits the parent; explicit zero/custom values override. Migration 1786674300000 adds request/assignment nullable break_minutes and shift default_starts_at/default_ends_at. Submitted parent starts/ends are the conservative assignment envelope; approval/bulk offer insertion can expand it atomically, never shrink it. Preserved defaults serve newly added staff; removed recipients do not shrink the operational envelope. Existing assignment.period remains the individual time authority. Effective break helper feeds estimated pay, attendance clock-out/corrections, report review and final timesheets. Manager review displays effective/default break.

Success sheet uses shared white rounded modal, centered pale-green check, truthful manager-approval copy and Done. It appears only after server success; double taps/ambiguous network retries remain guarded. Optional-break field owns its controller to survive sheet-close animation. Break-only edits do not freeze time defaults. No auth changes.

Runtime root cause VERIFIED: rab-server-1 compiled SubmitShiftRequestDto lacked staffAssignments despite current source supporting it. Local database migration applied, compiled API copied and container restarted; DTO now includes assignments/break and /healthz returns 200. A durable local image build is in progress; consult final verification entry/report before treating it as complete. No production deployment. Existing API/container data and unrelated working changes preserved.

Verification so far: full Flutter 382 passed; final focused 48 passed, analysis clean; normal Android APK built/installed/launched without clearing data. Server 146 passed, final contract subset recheck in progress. Worker unique final result 227 tests across 9 suites passed after correcting inactive test identities (no eligibility weakening). Manager UI 147 passed. Four-package build and server lint passed. Widget editor/success screenshots inspected. No authenticated native Send Shift/approval QA; report has explicit remaining native/release checks. Report: docs/VENUE-SEND-SHIFT-BREAKS-DTO-SUCCESS.md. Evidence: .audit/venue-assignment-times/*breaks*.

### Send Shift final verification (2026-09-30)
Flutter: 382 full-suite tests passed; final focused rerun 48 passed; analyze clean. Normal profile APK built and installed/launched on emulator-5554 without clearing data. Server: 146 passed across five suites; final contract subset 56 passed (not additional unique tests). Worker: 227 unique passing tests across nine suites, combining unaffected initial suites and the final four-suite recheck (89 passed). Frontend: 147 passed. Shared/server/worker/frontend builds and server lint passed. Standard Docker image build passed for local tag rab-venue-pipeline:local. Refreshed local API /healthz returned HTTP 200. Migration applied locally; production not deployed.
Final editor/success widget captures regenerated. Native authenticated submission/approval and physical iOS remain unverified. Whole-worktree whitespace check reports pre-existing EOF blank lines in final-timesheet.html.ts and pre-shift-report.html.ts; unrelated edits preserved.
Next: authorized native Send Shift/approval and physical iOS QA, then coordinated production migration/API/worker release. Full 32-section report: docs/VENUE-SEND-SHIFT-BREAKS-DTO-SUCCESS.md.

## PRE-01 worker RLS discovery remediation (2026-09-30)

PRE-01 CLOSED in source/local build and integration verification. New worker core/database/workspace-discovery.ts reads only workspace ID/org ID from the existing non-FORCE pre-auth catalogue using fixed READ ONLY owner queries, then runs candidate scans via READ ONLY rab_app tenant/workspace transactions (100-scope keyset pages, four concurrent scans). No new role, RLS policy, BYPASSRLS permission or migration. Final-timesheet ready-report insertion moved from privileged discovery to scoped locked/revalidated mutation. Original/final publication now also uses the existing worker_event claim/completion primitive alongside advisory locks, row locks, unique report.shift_id and delivery CAS. StoredFile ownership, per-staff periods/breaks and attendance facts preserved. Equivalent scheduler/shift/attendance/late/offer/replacement/cancellation discovery and invitation dependency checks no longer toggle protected-table RLS. No Flutter changes. Existing unrelated work preserved.

Verification: 282 unique worker tests / 12 suites and 110 server tests / four suites passed, including 13 real local-MinIO report/SMTP tests and 46 file-security tests. Report suite checks ENABLED/FORCED before/after, observes no RLS DDL or owner DML, cross-tenant/no-context isolation, stale readiness, failures and concurrent publication. Final four-package build, server lint and worker lint passed. Fresh disposable database rab_pre01_verified; local Redis/storage/MinIO, LOGGER or loopback SMTP only. Earlier missing bootstrap grants and obsolete plan/logger-test assumptions corrected transparently; final results supersede those failures. Evidence: .audit/pre01/verification-summary.json and logs. Report: docs/PRE-01-WORKER-RLS-DISCOVERY.md.

Remaining: PRE-02 email_outbox dispatch and PRE-03 stored_file maintenance retain distinct privileged RLS-toggling mutation workflows; discovery-lock.ts stays for those callers. No broad claim that the entire worker is free of RLS toggles or owner privileges. No proven cross-tenant exploit claimed. Workspace-scoped scan cost grows with workspace count; measure deployment capacity. Existing Docker container/image is not refreshed by this task. No production deployment or old RABBLO UI audit resumed. Next: user reviews PRE-01 results and remaining findings; coordinate worker build/release and resolve the old audit's broader no-RLS-toggle constraint before approved fresh workflow execution.


## PRE-02 / PRE-03 worker privilege remediation (2026-10-01)

Removed the remaining production email_outbox and stored_file RLS toggles. New server engine worker-shared/maintenance-catalogue.ts yields fixed, READ ONLY organisation/workspace IDs; business operations use rab_app under TenantContextService. Email uses per-org FOR UPDATE SKIP LOCKED claims (50 per organisation), unchanged attempts/lease/provider-fence classification, atomic audit, and commit-before-publish. Phase 9 processor/drivers and escaped payload generation are unchanged. Storage enumerates org-owned/null-workspace files once plus exact workspaces (200-row pages), commits stale-PENDING CAS before deletion and locks/revalidates terminal rows through HEAD/delete. Orphans remain report-only; image cleanup excludes report evidence.

Worker storage wiring now supplies catalogueDataSource only; injected metadata pool remains rab_app. Standalone storage:reconcile requires DATABASE_URL as rab_app and DATABASE_URL_UNPOOLED for a separately opened/closed catalogue pool; wrong-role execution fails before storage. Removed production discovery-lock.ts and obsolete runtime DDL timeout suppression; historical fixture consumers now import a test-only legacy helper. No schema/role/grant/policy migration. PRE-01 discovery/report logic is unchanged.

Verification: 417 unique tests across 20 suites pass with zero remaining failures/skips (301 worker, 116 server). Both lint targets and requested four-package build pass. PRE-02/PRE-03 CLOSED for source/local verification. Initial stale query-plan fixture corrected; overlapping global-sweep test interference resolved by a full serial cancellation rerun without weakening its assertion. Evidence .audit/pre02-pre03/; full 33-section report docs/PRE-02-PRE-03-WORKER-PRIVILEGE.md. Source audit covers 313 normal server/worker files with zero RLS mutation matches; local PostgreSQL flags remain ENABLE/FORCE on all six protected tables and unscoped rab_app email/file reads return zero. No production systems used.

Decisions/limits: retain owner credential for fixed catalogue reads, report advisory locks, existing token retention and invitation retention/dependency maintenance. This is not a claim that the entire process is least-privileged. Scope scans cost grows with tenant/workspace count; terminal purge holds one row lock during storage I/O. The removed global/table locks are not needed for claim uniqueness. No frontend/mobile changes; unrelated dirty work preserved. Production and local container images were not replaced. Next: review report and rebuild coordinated API/worker artifacts before rollout; use report-only storage reconciliation first. Owner-credential reduction and fleet-capacity measurements are follow-ups. Original RABBLO UI audit remains unresumed.


## RLS-only verification / manual-test boundary (2026-10-01)

User explicitly reserves application login, shifts, offer acceptance, clock-in/out and the full five-staff/report workflow for manual testing. Stop after backend RLS verification; do not resume the old UI audit. Fresh read-only checks reconfirm zero RLS mutation matches across 313 production source files, all six report/email/storage business tables ENABLED/FORCED, and unscoped rab_app email/file reads empty. Existing catalogue non-FORCE exemptions remain unchanged. Reused the completed 417-test/20-suite evidence and passing lint/build; no automated suites repeated and no application workflow run in this follow-up. Corrected only the stale Docker Compose comment describing the removed email RLS toggle; configuration values and runtime code unchanged. Local API/server and worker images still require rebuild/recreation before the user manually tests. No restart or deployment performed.

## Sent Shifts projection and Offers Kanban (2026-10-01)

New brief authorized isolated workflow regression tests for two presentation bugs, not resumption of the old report/timesheet UI audit. Sent Shifts grouped /offers and could not show pending-manager requests; counters counted staff offers. Added GET /shifts/sent and /shifts/sent/:id: guard/service SCHEDULE_VIEW, venue scope, session org, original requested_by, assigned venues and existing RLS. One Shift row, latest offer per staff, canonical assignment acceptance/confirmation counts. Confirmed offers survive assignment cancellation historically, so current counts must use assignment confirmed/completed as the web pipeline does. No migrations/state-machine/RLS/worker changes.

Flutter consumes this projection, preserves one card, truthful pending copy and zero counters before approval. Sent counts shifts with actual offers; Accepted includes confirmed staff; Confirmed requires all places. Five-second current-route polling retains search/filter/content, errors fail closed. Detail staff rows require the submitted projection. Kanban grows from 260px, cards fill inner width and board owns necessary overflow; keys/polling retained, full accessible names/title and keyboard menu focus preserved.

Verification: 113 unique server cases/six suites, 23 web/three suites, full Flutter383 passed. Stronger mapping rerun two and mobile capture rerun five passed (not double-counted). Flutter analysis clean; server/front lint/build passed. Actual-component/global-CSS browser fixtures at1024/1280/1440/1920/2560 and200% text: no body overflow, full card widths, keyboard menu, poll scroll retention. Seven columns need1892px, so1920 with sidebar scrolls intentionally;2560 fits. Mobile pending/sent/confirmed/declined captures and four phone widths checked. Evidence .audit/sent-shifts-fix/verification-summary.json; requested35-section report docs/SENT-SHIFTS-KANBAN-FIX.md. Earlier helper typo, cancelled-assignment count and test Unicode issues corrected; final relevant runs pass.

Limits/next: clean fixture's old /offers returns all five approved offers, so original postapproval-empty screenshot cause is not proven. Flutter defaultsAPI3000; QA web uses3101. Compiled QA server lacks listSentShifts; rebuild/recreate QA API before running updated mobile with API_URL=http://10.0.2.2:3101/rest/v1. QA front5174 bind-mounts source. No runtime replacement/mobile install/production/manual-QA database writes. Tests used disposable audit PostgreSQL55439/Redis56389, LOGGER/local storage. Previous PRE deployment limitations remain.

## QA web-runtime Kanban investigation - pending browser access (2026-10-01)

User requested actual running QA5174 verification with existing five-offer data, not another UI rewrite. QA front is healthy node:24-alpine Vite with workspace bind mount and polling watcher; route imports current VenueOfferPipeline and its CSS. Decoded HTTP-served injected CSS exactly matches working-tree source (flex1 0 260px); no old235/230 pipeline override or service-worker registration found in source. Browser requests from documented QA login use127.0.0.1:3101/rest/v1. No container restart justified/performed and no application/backend/state/security changes.

Actual existing board not yet verified: browser connector failed to start; independent documented QA account opens onboarding/profile and has zero requested shifts. Did not change onboarding, create fixtures or reset credentials. Opened visible Playwright QA login window; user asked to sign in to the account owning existing five offers and open Kanban. Helper .audit/web-runtime-kanban/interactive.cjs waits for board, then disables cache/reloads, captures five widths and source/computed/polling/network evidence without storing auth. Original user browser port also asked but not yet answered. Do not call this complete or infer wrong-port/cache cause without evidence.

21 web tests pass; front lint/build pass via unchanged Nx outputs. Partial24-section report .audit/web-runtime-kanban/report.md; source match/served metadata, container.json, network-api.txt and test logs alongside it. No screenshots of actual offer board yet. Next: obtain existing-account UI access, finish captures/computed styles and update report. Prior application source fixes and runtime deployment boundaries remain unchanged.

## Main local stack restored; real-board browser check pending (2026-10-01)

New user request supersedes the QA-only browser task: daily development must use5173/3000, not5174/3101. Stopped all services in docker-compose.qa.yml with stop (no removal). QA Postgres/Redis/MinIO container IDs and mount identities are unchanged. Rebuilt main server/worker using docker-compose.yml --profile s3, recreated only those two with --no-deps, restarted existing bind-mounted Vite front. Main front/server healthy and worker running; main Postgres55432/Redis6379/MinIO9000/9001 containers/volumes untouched. No fixture-org cleanup, database copy/reset, configuration/security/state-machine changes or manual workflow mutations.

Runtime verification: /healthz200, startup logs mount both /rest/v1/shifts/sent routes, anonymous requests401. Compiled projection present.311 normal compiled server/worker JS files scanned in new worker, zero RLS-toggle patterns; PRE workspace-discovery/maintenance-catalogue present. Main migration count87 and seven table ENABLE/FORCE flags unchanged; rab_app/rab_owner nonsuperuser/NOBYPASSRLS. Actual5173 login browser calls API127.0.0.1:3000/rest/v1 and has no service worker. Decoded served Kanban CSS equals current source. Normal Android source defaults10.0.2.2:3000; installed binary override not inspected or changed.

Full visual acceptance still pending existing-account login: cannot attach user's original browser; opened visible main5173 browser and asked user to open existing Venue Offer. Helper .audit/main-consolidation/browser.cjs waits for actual board, then captures widths/computed CSS/polling without writing tokens/cookies. Main login screenshot exists, NOT a claimed Kanban screenshot. Previous QA helper stopped. Do not resume QA normal development or mark full acceptance before authenticated board proof. Report docs/MAIN-LOCAL-ENVIRONMENT-CONSOLIDATION.md; build/runtime/data-preservation/network evidence .audit/main-consolidation. Next: user signs into existing main account, then finish screenshot/computed-style checks and update report.
