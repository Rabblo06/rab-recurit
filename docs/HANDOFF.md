# RAB Project Handoff

## 1. Project overview

RAB is a workforce recruitment/scheduling platform. Flutter serves Staff and Venue Manager; React serves the web console/portal. NestJS owns business rules. Read `../CLAUDE.md` for working agreements and `../rab-workforce-architecture.md` for the domain architecture.

## 2. Repository map

- `packages/rab-mobile/lib`: Flutter `core`, feature folders and `navigation`; tests under `test`.
- `packages/rab-front`: web client.
- `packages/rab-server/src`: `engine` platform services, `modules` staffing domain, `queue-worker`, versioned database migrations.
- `packages/rab-docker`: local infrastructure; shared packages contain domain contracts/utilities.
- `.qa-screenshots` under mobile contains local verification artifacts, not production modules.

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

Upcoming card → Details uses `pastelDetailRoute`, a custom shared-surface `PageRouteBuilder`, not Hero: 500 ms forward/reverse, captured rectangle/style, staged content reveal. Source remains until destination first frame; whole deck then hides. Restore on animation dismissal before overlay removal and keep input locked until route completion. Preserve early-Back cancellation and reduced-motion behavior. See mobile `.qa-screenshots/morph-restored/MORPH_RESTORATION_REPORT.md`.

## 13. Tests / verification commands

From `packages/rab-mobile`: `flutter analyze`, `flutter test`, `flutter build apk --profile`. Locally Flutter is installed at `C:/flutter/bin`. Important tests: home visual states, shift motion, navigation geometry, clock screen, schedule consistency, root-gate isolation, Venue Manager and report contracts. For backend changes run relevant integration/security suites using `packages/rab-server/package.json` scripts and `testing/integration-test-identities.md`. Never regenerate goldens without inspecting changes.

## 14. Known issues

Colour mismatch from encounter-order, list-index, fixed and status-based selection is resolved. Supplied screenshots alone do not prove two records share a Shift id. Title/rate discrepancies must be investigated separately using real ids if they persist. The existing Upcoming list can overlap rows near its pinned header while scrolling; this colour-only task did not redesign that layout.

## 15. Pending work

No remaining implementation work for the session-based colour-distribution task. Native QA covered the same five IDs in Staff Home/Upcoming/Calendar/Details, then completed History, and Venue Manager Calendar. History fixtures were completed through real signed-QR/geofence clock APIs after isolated fixture schedule adjustment; this is not a native scanner-flow test. Physical-device release QA and the existing Upcoming pinned-header overlap remain separate. Broad historical audit completion must not be inferred from this narrow colour check.

## 16. Decisions made

One canonical handoff here; AGENTS/CLAUDE link to it. Read it before edits, verify against current code and update after material work. No secrets or raw personal data. Do not duplicate stored project state in competing handoffs.

## 17. Do not regress

Stable shift colours; card morph and rear-layer handoff; fixed nav centres; authoritative completed state; role isolation; organisation/workspace RLS; server QR/geofence validation; API/Worker boundaries; secure shared storage; no production mock logic.

## 18. Last session handoff

2026-09-22: replaced direct hash-to-colour assignment with one session registry and whole-group allocation. Changed shared style resolver, OffersProvider, VenueManagerProvider, shared Upcoming deck registration and History registration; existing surface consumers inherit the registry. Added collision, palette exhaustion, neighbour avoidance, immutable mapping and session-repeatability tests. Analysis clean, 231 tests passed (including unchanged goldens and motion tests), Android profile build passed. Native screenshots inspected for five distinct palette colours and stable identity through Staff Upcoming/Home/Calendar/Details/History and VM Calendar. Three QA users deactivated, refresh tokens revoked; five completed shifts/attendance and immutable audit records retained. No production backend or motion/navigation/layout changes. Evidence: `../packages/rab-mobile/.qa-screenshots/shift-distribution/REPORT.md` and `comparison.html`. Next: physical-device release QA; persistent colours across cold restarts would require an explicit local-cache extension, not a return to direct hash mapping.


## 19. Latest session: Today/Details lifecycle (2026-09-22)

Implemented Next/Today/Live Home ? same ScheduleOfferDetailScreen through existing pastel morph. ShiftStatusControl renders Pending, Confirmed, server-anchored HH:MM:SS, Clocked Out, Complete and Expired. NOTE always appears; missing note ? No Details. Organisation timezone defines Today. Flutter uses server time plus monotonic elapsed interpolation; official duration/pay stay server-owned. Successful Clock Out retains its authoritative response, and stale live projections show Updating status until reconciled.

The subsequent Worker requirement supersedes the initial read-time-only projection. API persists clock-out immediately. Existing shift-monitor polling calls PostShiftLifecycleService for discovery and per-row advancement using runScopedForOrg, runtime RLS, explicit scope, row locks and atomic audit. Attendance payroll status remains unchanged; post_shift_completed_at and post_shift_expired_at persist clockOutAt +2h and +6h. Migration 1786672700000 adds columns, ordering constraint, due index and correction-reset trigger. No new enum/queue/runtime. PostgreSQL handles all threshold arithmetic. Existing five-minute cadence may process after eligibility; restart catches up from persisted clockOutAt. API reads milestones only. Null-workspace legacy records are excluded.

Final validation: clean Flutter analysis; 244 tests including unchanged goldens/motion/colour/navigation; Android profile build and install passed; server type-check passed; 12 projection tests, 6 Worker integration cases and 78 offer/attendance security integration cases passed. Worker tests include exact DB boundaries, discovery, concurrency, once-only audit, rerun/restart, corrections and tenant denial. Native camera Clock In/Out used the same signed QR on a dedicated QA shift with valid geofence. Timer increased and survived restart. Clocked Out, Worker-persisted Complete, Expired after restart, notes, Calendar/History and Next-card forward/back morph were verified. Timed native QA invoked the production service scoped to its fixture rather than globally sweeping unrelated data.

Cleanup completed: QA accounts deactivated, hashes cleared, tokens revoked, unused future shift cancelled; completed attendance and immutable audit retained. Private credential/QR files removed and camera poster reset. Evidence/report: `../packages/rab-mobile/.qa-screenshots/today-lifecycle/RAB_TODAY_SHIFT_OFFER_DETAILS_LIFECYCLE_REPORT.md`.

Release action: deploy migration before revised API/Worker; production deployment and physical-device checks are not part of this local task. Polling latency and inherited bounded owner-discovery locks are documented limitations. This does not certify the older broad UI audit. Existing unrelated dirty changes were preserved.


## 20. Home primary card colour correction (2026-09-22)

User explicitly restored the original fixed peach background (`ScheduleTokens.homePeach`, #F8ECDF) for the main Today/Next/Live card. This card is an intentional exception to per-shift identity colours; its background stays unchanged across records/states. Upcoming cards and Details retain the existing shift palette. The shared morph accepts an optional source colour so the fixed peach source transitions smoothly into Details without an initial colour flash. Lifecycle, routing and backend logic are unchanged.

Verification: targeted Home visual-state and shift-motion suites passed (71 tests).

## 21. Staff shift UI cleanup (2026-09-22)

Home primary compact card now shows actual shift date instead of address, preserving its fixed peach colour, venue, rate and time. UpcomingShiftCard reuses ScheduleRecordCard with optional scheduleLabel for date/time; its original compact height, Team Member and rate remain. The shared Job Details action builder renders a footer only for actionable offers, Clock In/Out, loading or errors. Removed Be Ready, Back to shifts and repeated passive lifecycle footer panels/text. Central ShiftStatusControl, actual Note/No Details, SafeArea and normal Back remain unchanged. No backend, lifecycle, palette or morph implementation changes.

Verification: flutter analyze clean; all 244 Flutter tests passed; profile APK built and installed. Metadata assertions cover Home dates/address removal and Upcoming date/time/team; lifecycle tests enforce a single status and absent footer CTAs. Reviewed Upcoming idle/pressed golden changes; golden fixtures now accept a fixed date to avoid time-dependent snapshots. Native Today/Upcoming, confirmed/no-note and clocked-out/real-note screenshots captured and inspected; top Back restored Home. QA attendance was prepared through real signed-QR/geofence APIs, not a repeat native scanner test. Evidence and cleanup details: ../packages/rab-mobile/.qa-screenshots/staff-ui-cleanup/REPORT.md. Next: normal physical-device release checks.

QA cleanup verified: all three disposable users deactivated, credentials cleared, tokens revoked and unused shift cancelled. Completed attendance/audit retained; local private credential/QR artifacts removed.

## 22. Production storage incident — Cloudflare R2 / S3 driver fixed (2026-09-24)

Root cause: `packages/rab-docker/docker-compose.production.yml` (the file OpenShip
deploys from) hard-coded `STORAGE_DRIVER=LOCAL` with a volume shared between rab-api
and rab-worker. An operator had set `STORAGE_DRIVER=S3` via OpenShip's own
environment-variable UI (overriding the committed default), but the env validator only
accepted `LOCAL` — both containers refused to boot. Fixed the compose file to the real
R2 shape (`STORAGE_DRIVER=S3`, `STORAGE_KEY_PREFIX=production`,
`S3_FORCE_PATH_STYLE=true`, `S3_SERVER_SIDE_ENCRYPTION=NONE` — R2 encrypts at rest
automatically and rejects AWS's SSE request headers) and removed the shared volume
(no longer needed or correct once storage is genuinely shared via R2, not a container
disk).

Also fixed, found during this incident: `S3_ENDPOINT` was not actually required when
`STORAGE_DRIVER=S3` (R2 has no default endpoint to fall back to — this alone could
cause a second, identical-looking incident); `STORAGE_KEY_PREFIX` had no
normalisation, so a trailing/leading slash produced a malformed key and a `../`
segment was not rejected — added `normaliseKeyPrefix()` (`storage-key-prefix.ts`),
applied at every key-building call site and validated at boot; `S3_FORCE_PATH_STYLE`
silently coerced any non-"true" value to `false` instead of failing validation.

Storage architecture itself (`FileService`, `S3StorageDriver`, `FileAccessRegistry`,
`stored_file` metadata table) already existed in this working tree from an earlier
session — see §11 above — this session's work was making it match the actual R2
production target and closing the gaps that would have caused a repeat incident, plus
adding real unit test coverage (mocked AWS SDK client — `s3.driver.spec.ts`,
`storage-driver.factory.spec.ts`, `storage-key-prefix.spec.ts`) that did not exist
before: previously the driver was proven only by integration tests gated behind a
local MinIO container, meaning ordinary CI never actually exercised the S3 code path.

One real pre-existing test-fixture bug found and fixed along the way (not a
production defect): `attendance-storage-outage.integration.spec.ts` seeded a `Shift`
directly at `status: 'open'`, which `SHIFT_TRANSITIONS` does not permit transitioning
to `in_progress` from — clock-in correctly rejected it with 409. Fixed the fixture to
seed `confirmed`, matching what the real request-approve-accept flow produces.

Verification: 61 new/updated unit tests (mocked S3 client, prefix normaliser, driver
factory, env-validation conditional matrix) all pass with zero infrastructure. Full
storage integration matrix (file-storage-security, report-storage-multiworker,
attendance-storage-outage, storage-s3-driver — real MinIO + real PostgreSQL) — 64/64
pass. Full server suite (LOCAL driver, default path) — 620/620 non-skipped pass, one
stale test count fixed (`identity-security-table-rls` — `avatar_file_id`'s legitimate
grant moved the safe-column count from 15 to 16; `password_hash`/
`totp_secret_encrypted` remain excluded, verified, not weakened). `docker compose
build` (amd64) and `docker buildx build --platform linux/arm64` (QEMU emulation —
production's actual Oracle Ampere architecture) both succeed, including argon2's
native build. Real Cloudflare R2 smoke test: BLOCKED — no real R2 credentials
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
