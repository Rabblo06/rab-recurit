# PRE-02 / PRE-03 — Worker Privilege Remediation

Date: 2026-10-01. Scope: source and disposable local verification only. No production deployment, runtime-container replacement, or resumption of the RABBLO UI audit.

## 1. Executive summary

Removed the last normal worker RLS toggles. Email claims/recovery and StoredFile metadata operations now use tenant-scoped `rab_app`. A fixed, transactionally read-only catalogue enumerates organisation/workspace IDs using the existing owner connection. No new database privileges, policies, functions or migrations. PRE-01 business discovery remains unchanged.

## 2. Remaining runtime RLS toggles before change

| File | Job/service | Table | Read/write | Why privileged access existed | Previous manipulation | Replacement |
|---|---|---|---|---|---|---|---|
| `rab-worker/src/queues/rab-email/email-dispatch.job.ts` | Email dispatch | email_outbox | Claim/recovery writes | Global eligible-row sweep | Owner transaction disabled/enabled RLS | Read-only organisation catalogue; per-org rab_app claims |
| `rab-server/src/command/storage-reconcile.command.ts` | Storage reconciliation | stored_file | Page reads, stale CAS, purge reread | Global inventory/maintenance | Three methods disabled/enabled RLS | Org/null-workspace and workspace scans; scoped CAS and locked purge |
| `rab-server/src/engine/worker-shared/discovery-lock.ts` | DDL contention helper | Caller tables | Lock configuration | Bound AccessExclusive waits | SET LOCAL lock_timeout before caller DDL | Removed from production; historical fixtures use test-only helper |
| `rab-worker/src/core/runtime/worker-runtime.ts` | Loop error handling | None | None | Suppressed discovery-lock timeout failures | No direct RLS SQL | Obsolete special case removed; failures use normal logging/retry |

The full pre-edit search is `.audit/pre02-pre03/source-inventory.txt`, with design classification in `original-design.md`. These were the last normal-runtime implementations. Historical migrations and legacy test fixtures are distinct from production jobs.

## 3. Trust-boundary architecture

`maintenance-catalogue.ts` returns only IDs from fixed SELECTs on the existing ENABLE/non-FORCE organisation and manager_workspace catalogues. Every catalogue transaction is READ ONLY, and no owner manager is passed to business callbacks. Pagination is keyset-based, 100 catalogue IDs per page. Normal business queries retain FORCE RLS.

Email uses organisation scope because email_outbox's existing policy is organisation-scoped, including messages with no workspace. Storage visits each organisation's null-workspace files once and then each workspace. It explicitly filters exact workspace equality in addition to RLS, avoiding duplicate org-owned files or extra report rows permitted by the existing read policy. No API permissions are broadened.

## 4. Original email-outbox architecture

One owner transaction acquired a global advisory lock, disabled RLS, selected eligible rows FOR UPDATE SKIP LOCKED, applied QUEUED/FAILED recovery changes and audits, re-enabled RLS, and published queue jobs before transaction commit. Per-email provider processing already used rab_app and processing-token fencing.

## 5. Why privileged mutation existed

The old global scan lacked an organisation context. It used table-security DDL to reach FORCE-protected rows. The replacement discovers organisations, then uses the existing policy for each organisation; no global outbox visibility is needed.

## 6. Final claim/lease architecture

Each organisation gets a rab_app transaction with the original eligibility predicate, ordering and FOR UPDATE SKIP LOCKED. Batch size 50 is now **per organisation**, not global. PENDING remains first-attempt generation zero. QUEUED older than two minutes, PROCESSING older than ten minutes and RETRY older than five minutes retain their existing recovery rules. Attempt exhaustion and ambiguous-delivery classification are unchanged. Recovery increments dispatch_generation atomically under row locks. Audit insertion is in the same transaction.

Claims commit before publication. A fast consumer sees the committed state. A crash or queue outage after commit leaves QUEUED work for the existing staleness recovery; generation-specific queue IDs avoid retained-job collisions. No transaction is held across queue publication.

## 7. Privileged boundary

The dispatcher owner's only job is fixed read-only organisation enumeration. Claimed rows contain IDs, state, counters and the provider-start marker, not rendered content or credentials. Runtime claim/recovery/audit writes use the injected TenantContextService and boot-verified rab_app pool. Tests identify the actual QueryRunner connection and assert no owner DML/DDL or owner email_outbox query.

## 8. RLS state

email_outbox stays ENABLED and FORCED. Every email reliability test asserts flags before/after, unscoped denial, and observed SQL without RLS DDL. Local catalogue inspection confirms rab_app is neither superuser nor BYPASSRLS. No RLS policy or grant changed.

## 9. Phase 9 fencing preservation

The provider processor and drivers are unchanged. processing_token, dispatch_generation, provider_call_started_at, stable `email-outbox:<id>` delivery keys, deterministic SMTP Message-ID and Resend idempotency remain. Ambiguous SMTP outcomes become FAILED/DELIVERY_UNCERTAIN, never blind resend. The new regression stalls generation one, recovers and completes generation two, then returns an old provider error: SENT cannot be overwritten. Persisted escaped HTML is unchanged across both attempts. HTML escaping and driver regressions also run.

## 10. Concurrency

Row locks and eligibility updates replace the unnecessary global dispatcher lock. Five concurrent dispatch cycles recover once. A new two-OS-process test runs independent database pools and the real dispatcher/processor; there is one claim and one fake-provider invocation despite deliberately duplicated queue delivery. The fake provider is local test evidence, not a live Resend/SMTP test. Real local SMTP coverage is provided separately by the lifecycle/report suites.

## 11. Failure/recovery

Failure before claim commit rolls back. Failure after commit but before publish is recovered from QUEUED. A publish exception does not erase the row or reset attempts. Provider-start ambiguity and attempt budgets retain their Phase 9 behavior. SENT, CANCELLED and fresh RETRY rows are not reclaimed. Previous committed organisations remain valid if a later organisation fails; the loop retries on its normal next tick.

## 12. PRE-02 tests

19 email reliability tests pass, including real BullMQ/loopback Redis, fencing, recovery, cross-org positive/negative controls, unscoped denial, owner SQL observation, RLS flags, publication failure, escaped payload persistence and independent processes. Email abuse/bulk-email, workspace attacks, ownership and Resend-driver regressions pass. See the final matrix below.

## 13. PRE-02 status

**CLOSED for source/local verification.** Deployment is not performed. This removes the RLS-toggle finding, not all historical worker process privileges.

## 14. Original StoredFile maintenance architecture

Global owner page scans and stale-PENDING/purge rechecks temporarily disabled RLS. Stale-PENDING already used a conditional UPDATE before deletion. DELETED/FAILED rechecks ended their database transaction before object deletion, leaving a gap for a restore or duplicate purge.

## 15. Final discovery model

Fixed catalogue IDs lead to rab_app READ ONLY pages of up to 200 StoredFiles within exactly one organisation/workspace (including null workspace). Only needed metadata columns are read. Every organisation and workspace can be visited without exposing business tables to the owner. Owner SQL observation verifies this boundary. Orphan comparison waits for all scopes to finish; failure aborts the run rather than presenting an incomplete inventory as authoritative.

## 16. Tenant-scoped mutation

The stale claim requires matching ID, object key, workspace, PENDING state and database-clock expiry. The scope is copied from the scoped discovery row, not client input. The claim commits before touching storage. Wrong-role CLI execution fails before storage access. A worker uses its injected rab_app pool plus its existing owner catalogue pool. Standalone `storage:reconcile` uses DATABASE_URL as rab_app and DATABASE_URL_UNPOOLED only for its explicitly created/closed catalogue pool; missing configuration fails closed.

## 17. Object-storage trust boundary

Storage list/head/get/delete remain trusted maintenance capabilities over the configured private prefix. Database RLS cannot restrict the object-store credential. No bucket policy, key format, access registry, download endpoint, MIME/magic-byte checks, checksum logic or preview generation was changed. These capabilities do not become API routes. A database transaction cannot make remote object deletion atomic; terminal metadata is retained for recovery.

## 18. Orphan behavior

Unknown objects remain **REPORT ONLY**, even with every cleanup flag enabled. No new orphan-deletion flag exists. The inventory is not a global transactional snapshot: concurrent new registrations can yield advisory false orphan reports, another reason not to auto-delete them.

## 19. Cleanup/CAS preservation

PENDING-to-FAILED CAS remains committed before deletion. If completion won first, cleanup cannot delete. A post-claim delete failure leaves FAILED metadata and the object for explicit failed-object recovery. failPending and tombstone logic in FileService are unchanged.

DELETED/FAILED purge locks and reloads the matching row, checks the current key/scope/status, and rechecks object presence while holding the row lock through delete. DELETED also checks database-clock age and the image-kind allowlist. Report/timesheet evidence is excluded from image purge. Missing objects are skipped. No metadata rows are hard-deleted or silently repaired.

## 20. Concurrency

Two purgers may discover the same row; the second waits for its lock, checks current state and HEAD, then skips an already-deleted object. The regression asserts exactly one destructive call. A restore cannot change the locked row between revalidation and deletion. Concurrent stale-PENDING runs retain exactly one winning claim. This does not promise exactly-once effects across an unknowable remote storage timeout; subsequent attempts reconcile the object's actual state.

## 21. Failure handling

Timeout before deletion leaves metadata/object intact. Database failure after object inspection prevents deletion. Failure after stale CAS leaves FAILED metadata, never restores PENDING. Terminal deletion failures retain terminal metadata and remain retryable. A process dying after successful deletion leaves a terminal row with no object, safely skipped on the next run. Existing missing/size/SHA-256 reporting is preserved. A storage outage may hold a per-file row lock until the driver returns; no table-wide DDL lock is taken.

## 22. PRE-03 tests

33 storage cleanup tests pass. Coverage includes pending timing/CAS, completion races, failed deletions, missing/corrupt objects, report exclusion, orphans, restore races, positive controls for two organisations and same-org workspaces, denied cross-scope updates, org-owned rows once, concurrent purge, timeout, database failure after HEAD, wrong-role refusal, flags and observed SQL. Separately, 46 real MinIO file-security tests and 13 multiworker report/storage tests pass.

## 23. PRE-03 status

**CLOSED for source/local verification.** Private-storage controls remain unchanged; production deployment is not performed.

## 24. Owner credential remaining usage

Do not remove DATABASE_URL_UNPOOLED yet. Exact retained worker usages:

- Fixed organisation/manager_workspace catalogue SELECTs in the new helper and PRE-01 workspace discovery.
- Existing report session advisory locks in pre-shift/final report rendering.
- Token cleanup: 30-day retention DELETEs on expired/revoked refresh_token and used/expired password_reset_token.
- Invitation cleanup: existing user/invitation expiry/retention maintenance and dependency checks, with foreign-key/savepoint fail-closed behavior and audit writes.

The process therefore still possesses a broadly privileged owner credential. It is not a fully least-privileged process. A follow-up can give retention jobs narrow operations/credentials and catalogue readers a narrowly granted role, then remove the owner pool; that requires its own retention/bootstrap review. No new grant or bypass was introduced here.

## 25. discovery-lock.ts disposition

Full search found only historical test/load consumers after replacing email/storage callers. Removed the production helper and the runtime's special DDL-lock error suppression. Moved the legacy helper to `rab-worker/src/__tests__/helpers/legacy-discovery-lock.ts` and updated five fixture imports. Historical load simulations remain explicitly test-only. Normal runtime failures are logged/counted and retried at the next scheduled cycle.

## 26. Runtime RLS-toggle inventory after fix

Zero matches across 313 normal server/worker source files, including engine and CLI command code. Search includes ENABLE/DISABLE/FORCE/NO FORCE RLS DDL and row_security-off patterns; historical migrations and tests are excluded by path, not relabelled as runtime. Evidence: `.audit/pre02-pre03/runtime-source-audit.json` and test SQL observations.

Final local PostgreSQL inspection: email_outbox, stored_file, shift, shift_report, shift_assignment and attendance are ENABLED/FORCED; rab_app and rab_owner are nonsuperuser/NOBYPASSRLS; unscoped email/file counts are zero. Existing catalogue non-FORCE exemptions are unchanged.

## 27. Files changed

Production: new `server/engine/worker-shared/maintenance-catalogue.ts`; `server/command/storage-reconcile.command.ts`; `worker/queues/rab-email/email-dispatch.job.ts`; worker main/runtime wiring; removed production discovery-lock helper. Paths are beneath the corresponding `packages/rab-server/src` or `packages/rab-worker/src` directory.

Tests: email-delivery-reliability and new child-process fixture; storage-cleanup-correctness; report-storage-multiworker and attendance-lifecycle caller wiring; five legacy lock-helper imports/test-only helper; manager-confirmation-timeout query-plan regression. Documentation: this report, root HANDOFF and THREAT-MODEL. Local audit evidence stays under `.audit/pre02-pre03/`. Existing unrelated dirty work is preserved. No frontend/mobile/UI changes.

## 28. Migrations

None. No tables, columns, policies, roles, grants or SECURITY DEFINER functions changed. A fresh disposable database was bootstrapped with standard default grants **before** existing migrations, preserving their later explicit revocations. Fresh/upgrade migration testing for a new migration is not applicable.

## 29. Regression matrix

| Suite | Passed | Evidence |
|---|---:|---|
| bulk-email-abuse-cases.integration.spec.ts | 5 | `.audit/pre02-pre03/server-security.json` |
| email-outbox-abuse-cases.integration.spec.ts | 14 | `.audit/pre02-pre03/server-security.json` |
| file-storage-security.integration.spec.ts | 46 | `.audit/pre02-pre03/server-pre01-s3.json` |
| resource-ownership-abuse-cases.integration.spec.ts | 8 | `.audit/pre02-pre03/server-security.json` |
| storage-cleanup-correctness.integration.spec.ts | 33 | `.audit/pre02-pre03/server-storage.json` |
| workspace-cross-tenant-rls-attack.integration.spec.ts | 1 | `.audit/pre02-pre03/server-security.json` |
| resend.driver.spec.ts | 9 | `.audit/pre02-pre03/server-security.json` |
| account-invite-cleanup.integration.spec.ts | 11 | `.audit/pre02-pre03/worker-pre01-regressions.json` |
| attendance-lifecycle-42.integration.spec.ts | 42 | `.audit/pre02-pre03/worker-pre01-regressions.json` |
| email-delivery-reliability.integration.spec.ts | 19 | `.audit/pre02-pre03/worker-email.json` |
| late-clock-in-correctness.integration.spec.ts | 26 | `.audit/pre02-pre03/worker-pre01-regressions.json` |
| manager-confirmation-timeout-correctness.integration.spec.ts | 29 | `.audit/pre02-pre03/worker-timeout.json` |
| offer-lifecycle-correctness.integration.spec.ts | 26 | `.audit/pre02-pre03/worker-pre01.json` |
| replacement-staff-workflow.integration.spec.ts | 41 | `.audit/pre02-pre03/worker-pre01-regressions.json` |
| report-storage-multiworker.integration.spec.ts | 13 | `.audit/pre02-pre03/worker-pre01-s3.json` |
| report-worker-concurrency.integration.spec.ts | 10 | `.audit/pre02-pre03/worker-pre01.json` |
| same-org-manager-isolation.integration.spec.ts | 17 | `.audit/pre02-pre03/worker-pre01-regressions.json` |
| shift-cancellation-correctness.integration.spec.ts | 28 | `.audit/pre02-pre03/worker-cancellation.json` |
| worker-event-idempotency.integration.spec.ts | 21 | `.audit/pre02-pre03/worker-pre01-regressions.json` |
| worker-operations-abuse-cases.integration.spec.ts | 18 | `.audit/pre02-pre03/worker-pre01-regressions.json` |

**Final unique total: 417 tests across 20 suites; zero remaining failures or skips.** See `.audit/pre02-pre03/verification-summary.json`.

Final per-suite outcomes replace earlier attempts; overlapping tests are not double-counted. Initial type-check failures were fixed. An obsolete query-plan assertion in manager-confirmation-timeout was replaced with the actual rab_app/RLS query, bounded limit and index-presence assertion; PostgreSQL legitimately chooses plans based on fixture statistics. The failing original run is retained as evidence. A concurrently launched timeout-suite rerun performed a global cancellation sweep against a cancellation-test fixture, causing an unrelated assertion failure; the entire cancellation suite subsequently passed serially without changing that assertion. Run global worker-sweep suites serially or use separate databases. An early storage run against accumulated PRE-01 fixtures was stopped and replaced by the fresh database run. Jest forceExit and existing deprecation warnings remain; these results do not certify absence of open handles.

## 30. Build/lint

Requested server lint, worker lint, and `yarn nx run-many -t build -p rab-shared rab-server rab-worker rab-front` pass. Lint targets are the repository's TypeScript no-emit checks. Nx reused unchanged dependency artifacts; changed server/worker compiled. The existing Vite >500 kB chunk warning remains. No container image was rebuilt or deployed.

## 31. Test-environment safety

Only the existing disposable loopback PostgreSQL/Redis containers and loopback MinIO were used. A fresh database `rab_pre0203_verified` isolates this task. LOGGER, fake in-process/child-process providers and local SMTP sinks replace real providers. No production Neon/Redis/R2/Resend/SMTP or real client data was used. Tests use standard schema/bootstrap grants and migrations, not security weakening to manufacture a pass.

## 32. Newly discovered findings

The former publication-before-commit ordering and terminal-purge validation gap were eliminated as part of these changes. No demonstrated cross-tenant exploit is claimed. Retained limitations: broad owner credential for existing retention jobs; catalogue work proportional to organisation/workspace count; knownKeys memory proportional to registered file count; per-file lock duration depends on storage response time. Measure cadence/capacity before production rollout. No new schema/index is justified by an unmeasured production load.

## 33. Remaining work

No remaining implementation for the two RLS-toggle findings. Deployment/release checks remain operational work: rebuild coordinated server/worker runtime images, retain both app and catalogue connection configuration, run reconciliation report-only first, then enable existing scheduled flags and observe queue recovery/cleanup metrics. The old locally running images remain stale. Owner-credential reduction and large-fleet capacity testing are follow-ups; the prior RABBLO UI workflow audit has not been resumed.

PRE-02 STATUS: CLOSED
PRE-03 STATUS: CLOSED
