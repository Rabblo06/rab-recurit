# PRE-01 ? Worker RLS Discovery Remediation

## 1. Original design
Owner-connection discovery toggled table RLS inside a transaction, with an advisory discovery lock and 250ms DDL lock timeout. Final-timesheet discovery also inserted ready reports through that owner connection. It selected finalised unsent reports and resolved shifts missing an original snapshot. Relevant assignments are confirmed/completed/no_show; active attendance and missing required clock-outs block readiness. Each report scan was capped at 200. Source and pre-edit snapshots: .audit/pre01/.

## 2. Why the worker disabled RLS
The direct owner connection has no tenant context and cannot see FORCE-protected business rows. The old implementation changed the tables' security state to discover across tenants. Existing manager_workspace is already an ENABLE-but-not-FORCE pre-auth catalogue; its owner can enumerate IDs without any new grant or policy.

## 3. Security assessment
This was privileged DDL and an availability/trust-boundary risk, not a demonstrated cross-tenant exploit. Transactional DDL and exclusive locks limited concurrent exposure. The new business-job path removes those table locks and RLS state changes entirely.

## 4. Final discovery architecture
One discoverInWorkspaces primitive performs fixed SELECT id, organisation_id from manager_workspace in READ ONLY owner transactions. Keyset pages contain at most 100 scopes. Each workspace candidate scan uses TenantContextService and rab_app in a READ ONLY transaction, with at most four scans concurrently. The callback never receives an owner manager. Organisation filtering only narrows trusted worker scope. No arbitrary SQL from an API client, new role, SECURITY DEFINER function or BYPASSRLS grant.

Query cost is proportional to workspace count: ceil(N/100)+1 catalogue queries and N scoped scans (plus transaction/context statements), rather than a cross-tenant business-table scan. Limits of 200/500 are now per workspace. Empty workspaces therefore cost a small transaction; very large fleets should measure cadence/capacity before release. Existing manager_workspace primary/org indexes, shift workspace/org-start indexes, unique shift_report.shift_id, shift_report status, assignment workspace/shift-staff, and attendance workspace/shift/unique-assignment indexes are retained. Actual pg_indexes and RLS/role evidence: .audit/pre01/inspect.log. No new index justified or claimed from an unmeasured production load.

## 5. Privileged trust boundary
The new primitive's privileged phase returns only scope IDs, is transactionally read-only, and cannot call candidate callbacks on the owner connection. Existing direct owner session advisory locks still serialize PDF rendering. The process retains its old owner credential for separate maintenance jobs; this change does not claim the entire worker process is least-privileged or remove its historical administrative capability. Normal runtime rab_app remains non-owner, nonsuperuser, NOBYPASSRLS.

## 6. Scoped mutation architecture
Final-timesheet discovery is SELECT-only. Ready-report insertion moved to a scoped transaction after locking/reloading the shift and checking readiness/cancellation. Report reads, file registration, original-file update, final delivery CAS, worker_event and outbox writes use rab_app with both organisation and workspace. Before publishing an original, the worker reloads shift/report and rechecks readiness/cancellation. Finalised historical reports retain their existing delivery semantics; cancellation is not used to erase already-finalised attendance history. Discovery is a hint, never authority. StoredFile policy and ownership remain unchanged. Assignment.period and effective individual breaks remain separate from actual attendance.

## 7. RLS state before/after
Integration tests assert ENABLED and FORCED on shift_report, shift, shift_assignment and attendance before and after every report test, including concurrency and failures. Query observation rejects any ALTER TABLE ENABLE/DISABLE RLS during the report tests. Unscoped rab_app reads still return zero rows.

## 8. Removal of ALTER TABLE RLS operations
Removed from final-timesheet, pre-shift scheduler, shift monitor/lifecycle discovery, attendance monitor, late-clock-in, offer expiry/confirmation timeout, replacement and cancellation discovery. Invitation-cleanup protected-table dependency inspection also now enumerates real workspaces with RLS unchanged; database foreign keys/savepoints preserve fail-closed retention of hidden legacy or racing dependencies.

## 9. discovery-lock.ts disposition
Retained after full source usage search. Distinct email-dispatch and storage-reconcile paths still use it. Report/staffing discovery no longer imports it or takes AccessExclusive table locks. Historical migrations are unchanged.

## 10. Other workers audited
| Job | Previously altered tables | Reason | Fixed here? | Carried forward |
|---|---|---|---|---|
| Final timesheet | shift_report, shift, shift_assignment, attendance | Discovery + ready-report creation | Yes | None for this path |
| Pre-shift scheduler | shift, shift_report | Discovery | Yes | None |
| Shift monitor | shift_assignment, shift, attendance | Reminders/no-shows/lifecycle | Yes | None |
| Attendance monitor | attendance, shift | Missing clock-out scopes | Yes | None |
| Late clock-in | shift_assignment, shift, attendance | Candidate discovery | Yes | None |
| Offer expiry / confirmation timeout | job_offer | Candidate discovery | Yes | None |
| Replacement | job_offer, shift_assignment, shift, replacement_request | Candidate discovery | Yes | None |
| Cancellation follow-up | shift, shift_assignment, replacement_request | Candidate discovery | Yes | None |
| Invitation cleanup | shift, job_role, venue, shift_assignment, job_offer | Dependency safety checks | Yes | Existing owner maintenance writes remain |
| Email dispatch | email_outbox | Privileged lease/claim/recovery mutations | No | PRE-02: separate transaction/lease architecture |
| Storage reconciliation | stored_file | Cross-tenant integrity/orphan/purge maintenance | No | PRE-03: separate storage maintenance architecture |
| Token cleanup | None found | Existing maintenance | Not applicable | Existing owner maintenance remains |

PRE-02/PRE-03 are verified architectural findings, not demonstrated exploits. They are materially different privileged mutation workflows, not read-only staffing candidate scans. A whole-worker prohibition on *all* RLS toggles is not yet satisfied; do not silently restart the original audit under that broader constraint.

## 11. Cross-tenant tests
Two organisations/workspaces contain real shift, assignment, attendance, report and StoredFile rows. Discovery sees both through separate rab_app contexts. Each scoped context sees its own positive controls, cannot read or update the other's rows; unscoped access stays empty. Separate existing workspace/ownership attack regressions also run.

## 12. Concurrency/idempotency
Preserved per-shift session advisory serialization, unique report.shift_id, original-file row lock and final_pdf_sent_at CAS. Added existing claimWorkerEvent/completeWorkerEvent primitives for original and final publication, atomically with file registration and outbox writes. A failed transaction rolls back its event claim. No durable lease is held across rendering; the session advisory lock covers that interval. Concurrent tests require one logical delivery/email, immutable original/signed files and completed ledger events. Existing Phase 2 job claims are unchanged.

## 13. Failure behavior
Storage/render failures leave retriable work; rejected uploads are discarded. Cancellation while rendering prevents original publication and creates no file/event. A failure never requires restoring RLS because these paths never change it. Existing per-candidate error isolation is retained.

## 14. Files changed
New worker core/database/workspace-discovery.ts; eight staffing/report job files (including both offer-expiry cycles); invitation-cleanup dependency checks; report-worker-concurrency and offer-lifecycle integration tests; worker/main.ts and scoped-job.ts comments; server post-shift-lifecycle comment; this report, root THREAT-MODEL.md and docs/HANDOFF.md. Existing unrelated dirty work preserved. No Flutter changes.

## 15. Migrations
NONE. No table, role, policy, grant or production schema change.

## 16. Test results
Final unique results: **282 worker tests across 12 suites; 110 server tests across four suites; zero remaining failures/skips in that union.** Includes final report/RLS + offer rerun (36), real MinIO multiworker report tests (13), real MinIO file-security tests (46), and server ownership/assignment checks (64). The initial broad worker run had one obsolete EXPLAIN failure; the entire offer suite subsequently passed. The final per-suite result replaces earlier results; counts are not added twice. See .audit/pre01/verification-summary.json and its listed JSON/log files.

All report tests assert the four RLS flags before/after and observe no RLS DDL. Privileged SQL observations identify the actual QueryRunner connection (test DataSources share a logger), and assert no owner DML/DDL during final-timesheet execution. Both tenant fixtures have positive business-row controls. The new discovery callback rejects writes in a read-only transaction.

Tests used fresh rab_pre01_verified in the existing disposable loopback PostgreSQL container, loopback Redis, local storage or verified local MinIO, LOGGER mail/local SMTP sink only. Standard schema/default grants were installed before migrations; migration-specific revocations remain intact. The first fresh bootstrap omitted grants and failed; that evidence is preserved and not counted as a pass. An earlier slow run against ~3,000 accumulated workspaces was stopped and replaced by the fresh database run. No production testing. Existing Jest forceExit and dependency deprecation warnings remain; these tests do not certify absence of open handles.

## 17. Build/lint
Final requested four-package build and server/worker lint passed. Nx reused unchanged dependency/frontend outputs; the changed worker compiled successfully. Vite reports its existing >500kB chunk warning. No production deployment and no local running-container replacement in this task.

## 18. Remaining findings
PRE-02 email-outbox and PRE-03 stored-file maintenance still toggle their own tables' RLS. Owner process credential remains broadly privileged. Large workspace fleets need scan-capacity measurement. Full RABBLO UI workflow, native device QA and production rollout are not performed. Existing compiled Docker image/container from the previous task is stale relative to this source; rebuild coordinated runtime artifacts before use.

## 19. PRE-01 status
**PRE-01: CLOSED** for the report path and the four protected tables in normal staffing/report worker execution. Source and locally compiled final-timesheet code contain no RLS toggles; integration evidence proves discovery/processing with RLS enabled and forced. No deployment performed. PRE-02/PRE-03 remain separate findings. The old audit was NOT resumed; await review before any fresh workflow.
