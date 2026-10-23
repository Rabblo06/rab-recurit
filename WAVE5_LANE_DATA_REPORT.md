# Wave 5 — lane DATA: archive/restore, ranked search, field permissions, activity timeline

**Date:** 2026-10-23 · **Branch:** `feat/twenty-parity-foundation` · **Nothing committed, pushed, deployed or migrated
outside the private lane DB.** No migration written (schema from lane DB5: `ArchiveAndSearchSchema1786719920000`,
`AuditLogTimelineIndex1786719950000`, `FieldPermissionObjects1786719970000`). rab-devdb, crewflow-test-db and every
running container were left alone. Evidence: `docs/evidence/w5-data/` (index in its `README.md`).

## 1. Design per feature

### 1.1 Archive / restore (CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.9)
- **Named actions** (never a status / `archivedAt` write; DTOs don't declare them → 400):
  | Action | Route | Guard flag (re-checked in service) | Preconditions |
  |---|---|---|---|
  | archiveVenue / restoreVenue | `POST /venues/:id/archive|restore` | `venue.edit` | status + archive transitions |
  | archiveJobRole / restoreJobRole | `POST /job-roles/:id/archive|restore` | `schedule.create` | own role only |
  | archiveShift / restoreShift | `POST /shifts/:id/archive|restore` | `schedule.create` | **draft only** (CAS update; DB CHECK backstop) |
  | archiveStaff / restoreStaff (leaver) | `POST /staff/:id/archive|restore` | `staff.deactivate` | deactivated first; no upcoming/open booking |
  | archiveManagerProfile / restore | `POST /managers/:id/archive|restore` | `manager.manage` | suspended first; never self; never the current Initial Manager; CEO needs platform admin (existing rule) |
- `@rab/shared`: new `ARCHIVE_TRANSITIONS` (`active ⇄ archived`, `archiveStateOf(archivedAt)`); `VENUE_TRANSITIONS` gained the
  restore edge `archived → active`. Repeat archive/restore = 409 `InvalidTransitionError`.
- Audit actions `venue|job_role|staff|manager|shift.archived/.restored` (entity + `targetUserId` for people), plus
  `shift.created` / `shift.published` (timeline steps 1–2). Metadata never carries pay or email.
- **Lists exclude archived by default**, `?includeArchived=true` (strict boolean; anything else 400) for venues, staff,
  managers, shifts; venues also via `status=archived`. Global search excludes archived. **History/FK reads do not**:
  `GET /:id`, attendance list, shift report, payroll — tested with an archived staff member at an archived venue.
- `GET /job-roles` is treated as a **reference/FK read** (Calendar, Shifts and the VM app resolve historical role names
  through it): archived roles stay listed with `archivedAt`; pickers hide them; the write side refuses them (409
  `JOB_ROLE_ARCHIVED`); re-creating an archived role's name → 409 `JOB_ROLE_ARCHIVED_NAME` ("restore it instead").
- Restore conflicts: DB5 kept every unique total, so a restore **cannot** collide (contract §3) — the conflict surfaces at
  create, handled as above. Invariant "archived ⇒ inactive/suspended": reactivating an archived person is a 409.
- Front: `shared/hooks/useArchiveRestore.tsx` (confirm dialog → named action, server message on refusal) used by Venues
  (Active / Archived / All tabs), Users (staff + managers, "Show archived" filter), Shifts (draft archive/restore,
  "Show archived" filter). Name-resolution queries (Shifts, Calendar) request `includeArchived=true` under their own key.

### 1.2 Search (§3.13)
- `search-query.ts` is the only place input becomes parameters: prefix tsquery terms (letters/digits only, ≤6×64), escaped
  LIKE pattern, control characters stripped (a NUL used to 500), email prefix only for an email-like query.
- `SearchService`: FTS on DB5's generated `search_vector` (user names, staff ref + preferred name, venue name + client
  name) with `to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1)))`, trigram infix fallback (≥3 chars) on the
  exact indexed expressions; ranking exact → `ts_rank_cd` → `similarity` → name → id. Permission gating, scope predicates,
  member record filters and hidden-field rules unchanged; email matched only when the field is visible; venue vector used only
  when `clientName` is visible; a shift's own vector (address/notes) is deliberately not searched (see W5D-1). Shifts are
  venue-driven and newest-first (as before). Per-transaction `jit = off`, `statement_timeout = 5 s`.
- Front: GlobalSearch / CommandPalette already call `GET /search`; no UI change needed.

### 1.3 Field permissions (§3.8)
- New `field-policy.registry.ts` + `FieldPolicyService` (global, layer 2). Objects `attendance` (`workedTime`, `earnings`) and
  `payroll_record` (`workedTime`, `payRate`, `amount`). Money fields need `payroll.view` **now** (PermissionsService, never
  the JWT), and are always hidden for a venue-scoped caller (mirrors `PayrollService.canAccessPayroll`). Custom members also
  need every custom role to allow the field (`role_field_permission`, default hidden for money); no role ⇒ all hidden.
- Applied to: `GET /attendance` (properties absent; earned filters and sort ignored when hidden — no probing),
  `POST /attendance/:id/correct` response, shift report seats (`earnedPence`), `GET /payroll/records`, `/payroll/period`,
  payroll-run detail and **CSV export** (columns built from visible fields; formula injection neutralised).
- Kept separate from `MEMBER_OBJECTS` on purpose: adding objects there would let the role editor request
  `attendance.view`/`payroll.view`, which the member allowlist refuses (owner decision).

### 1.4 Activity timeline (§3.15)
- New `modules/timeline/` (read model only): `GET /rest/v1/timeline/{shifts|offers|staff|attendance|payroll-records}/:id`
  with `limit ≤ 100` and an opaque microsecond keyset cursor. Visibility = the owning service's read rule (404 out of
  scope); flag re-checked; audit query pinned to the organisation and to entity ids resolved under workspace RLS, using
  DB5's `audit_log_timeline_idx`. Shift timeline = shift + seats + offers + attendance + report + replacement requests +
  reviews (+ payroll records for payroll-capable callers). Metadata allowlisted; money keys only with payroll access;
  custom members see only the entity's own rows.
- Front: `features/scheduling/ShiftTimelinePanel.tsx` (existing timeline styling, "Load older activity") opened from the
  Shifts row; the staff detail panel's Timeline tab now uses `/timeline/staff/:id`.

## 2. Permission flags
**None added.** Every action reuses an existing catalogue flag (table above); no DB5 catalogue rows were needed.

## 3. Schema requests to DB5 (not blocking)
1. `role_field_permission.object_key` CHECK: add `payroll_record` (this lane's registry key; v1/v2 widened to
   attendance/offer/shift_report only). Until then member rules for payroll fields cannot be stored (defaults apply).
2. **W5D-1 decision support:** either `LEAKPROOF` on `ts_match_vq`, `textlike` and `pg_trgm`'s `similarity`/`%` (superuser,
   cluster-wide — needs a security review), or another index-usable design; without it the new indexes help only
   owner/worker paths.

## 4. Benchmark (50,000 staff · 50,000 shifts · 2,000 venues; `crewflow_app`, RLS on; median of 7 EXPLAIN ANALYZE)
| query | before (as shipped, JIT default) | before, JIT off | **after (as shipped)** |
|---|---|---|---|
| staff `smith` / `zoe` / `mith` | 952 / 1210 / 1296 ms | 152 / 164 / 220 ms | **402 / 531 / 499 ms** |
| staff `STAFF 4217` / no match | 1343 / 1285 ms | 224 / 205 ms | **176 / 225 ms** |
| venue (all terms) | 1.8–3.5 ms | 1.7–4.0 ms | 3.9–14.8 ms |
| shift (all terms) | 1.3–52 ms | 1.2–53 ms | 1.7–74 ms |
Full plans: `docs/evidence/w5-data/benchmark/01-explain-before-after.md`. Without RLS the same predicates use the GIN /
trigram indexes in ≈11 ms (`02-superuser-index-potential.txt`). Reading: as shipped, staff search is 2.4–7.6× faster (JIT
was the multi-second cost); apples-to-apples with JIT off it is ~2× slower for common names because it now ranks every
match and the indexes cannot be used under RLS (W5D-1).

## 5. Tests (all seen passing; logs in `docs/evidence/w5-data/tests/`)
| Suite | Result |
|---|---|
| `w5-archive-restore.integration.spec.ts` (V1–V9, J1–J4, S1–S4, L1–L7, M1–M4) | 28/28 |
| `w5-search.integration.spec.ts` (ranking, accents, prefix, trigram, archived, cross-workspace/org = 0, injection, email gate) | 7/7 |
| `w5-timeline-field-permissions.integration.spec.ts` (F1–F4, T1–T9 incl. other-org audit row, pagination, no write route) | 14/14 |
| unit: field policy + CSV, search-query, timeline cursor/metadata | 9 + 9 + 6 |
| rab-shared state (archive + venue transitions) | 30/30 |
| targeted regression (16 suites) | 365/366 — only `shift-team` (pre-existing known failure) |
| rab-front affected folders + 2 new specs | 246/246 + 6/6 |
| full rab-server (unit + integration, `50-…`) | 2673 passed / 32 failed / 66 skipped, 215 suites. 1 failure was mine (`access-control-hardening` expected 201 from venue archive; archive/restore routes now keep Nest's POST 201 → re-run 55/55 incl. all w5 suites, `52-…`). The rest: known pre-existing (tenant-context ×3, identity-security-table-rls ×2, shift-team ×1) and other lanes' in-flight work on this DB (posture golden + workspace-security-coverage = DB5's un-regenerated golden for its new indexes; w45-db5 MFA/handoff, login-handoff-wave4, secret-rotation-wave5 = MFA/OPS against DB5 v1 functions applied before contract v2) |
| full rab-front | 715/715 (74 suites) |
| full rab-shared | 117/117 |
Abuse cases covered: guard 403 vs scope 404 (other workspace, other organisation), repeat transitions 409, preconditions,
mass assignment 400, DB CHECK backstop, archived-still-visible-in-history, injection-shaped search input, hidden email,
money absent (REST + CSV) and un-probeable, timeline isolation and forged cursors.

## 6. Findings (§5.8)
**W5D-1 — Medium (performance/availability).** Actor: any user typing in global search on a large tenant → each keystroke
scans the tenant's users/staff under RLS (0.2–0.65 s at 50k; was 1–2 s with JIT). Location: `search.service.ts`; root
cause: `@@`, `LIKE`, `similarity` are not LEAKPROOF, so PostgreSQL evaluates them after the RLS quals and cannot use DB5's
GIN/trigram indexes for `crewflow_app` (proved by `02-superuser-index-potential.txt`). Partial fix shipped: `jit = off` +
`statement_timeout` per search transaction, venue-driven shift search, shift text not searched. Full fix: owner/DB5 decision
(§3.2). Regression test: the benchmark harness (`__tests__/load/w5-search-benchmark.ts`).

**W5D-2 — Low (fixed).** Venue Manager → shift report / attendance outputs → received `earnedPence`/`payrollApprovedPence`
without `payroll.view`. Fix: FieldPolicyService (owner rule "pay follows payroll.view"). Tests: F1–F3, manual-attendance.

**W5D-3 — Low (fixed).** Anyone → `GET /search?q=<NUL>` → 500 (`invalid byte sequence 0x00`). Fix: control characters
stripped in `buildSearchQuery`. Tests: R6, search-query spec.

**W5D-4 — Low (fixed).** Manager → staff named `=HYPERLINK(...)` → payroll-run CSV opened in a spreadsheet evaluates it.
Fix: `csvCell` prefixes `= + - @ TAB CR`. Test: field-policy spec.

## 7. Security trade-offs (for veto)
- **`GET /job-roles` returns archived roles** (with `archivedAt`) instead of excluding them, because it is the FK/name
  lookup for historical shifts in Calendar, Shifts and the VM app (mobile not in this lane). Writes refuse archived roles.
- **Hidden-field filters/sorts are ignored, not 400** (matches the existing staff-list pattern; a 400 would itself disclose
  that the field exists and is hidden).
- **Search runs with `jit = off`** (transaction-local) — safe, but a global planner behaviour change for that transaction.

## 8. Owner decisions needed
1. Confirm the archive preconditions (staff: deactivated + no upcoming booking; manager: suspended, never self, never the
   current Initial Manager) and "no new shift/request at an archived venue / with an archived job role".
2. Archived-row retention (never purged today) and Initial-Manager archiving (refused today).
3. Owner decision #12 remainder: offer `payRatePence`/`estimatedPayPence` and shift `payRatePence` still reach Venue
   Managers (offer/shift reads outside this lane's field policy).
4. W5D-1: LEAKPROOF vs. accepting scan-based search for large tenants.
5. Whether `includeArchived` should also apply to the dashboard counts and the VM staff directory (both unchanged; archived
   people are inactive/suspended so the directory already omits them).
6. **MOBILE lane follow-up (not in this lane's files):** the Venue Manager app resolves venue names of its shifts through
   `GET /venues` (`venue_manager_provider.dart:266`); after a venue is archived those shifts show "Venue unavailable". One-line
   fix there: `all('/venues?includeArchived=true')` (same pattern the web Shifts/Calendar now use). Server unchanged on purpose
   (one list rule for every caller).

## 9. Files
Server: `modules/{venue,scheduling,staff,manager}/{controllers,dto,entities,services}` (archive), `modules/search/services/
{search.service,search-query}.ts`, `modules/identity/member-access/{field-policy.registry,field-policy.service,
member-access.module,member-object-registry}.ts`, `modules/attendance/services/{attendance,shift-report}.service.ts`,
`modules/payroll/services/{payroll,payroll-run}.service.ts`, `modules/timeline/**` (new), `engine/dto/include-archived.decorator.ts`
(new), `engine/core-modules/audit/audit.service.ts` (actions only), `app.module.ts` (TimelineModule). Tests: 3 new integration
suites, 3 unit specs, `manual-attendance` updated for W5D-2, `__tests__/load/w5-search-benchmark.ts`. Shared:
`state/{archive-transitions,venue-transitions}(.spec).ts`, `state/index.ts` (dist rebuilt with plain tsc). Front:
`shared/hooks/useArchiveRestore.tsx`, `features/venues/Venues.tsx` (+spec), `features/users/{Users,UserDetailPanel,
CreateUserModal}.tsx`, `features/scheduling/{Shifts,Calendar,ShiftDrawers,ShiftRequestDrawer,ShiftTimelinePanel(+spec)}.tsx`.
Docs: `THREAT-MODEL.md` (appended "Wave 5 Lane DATA"), `docs/HANDOFF.md` (appended).
