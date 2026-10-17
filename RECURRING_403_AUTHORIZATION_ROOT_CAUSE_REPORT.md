# Recurring 403s on the Users page: root cause report

Date: 2026-10-15, applied 2026-10-16 with owner approval. Scope: local development only. Nothing is committed, pushed or deployed.

## Verdict: PASS

- The root cause is proven.
- The durable fix is applied: migration `1786718000000` on `rab-devdb`, then the API, worker and provisioner recreated from the rebuilt images.
- Every endpoint that returned 403 now returns 200, including after a full `compose down`/`up`.

## 1. Cause of each 403 (reproduced against the running stack, signed in as `issac@gmail.com`)

`GET /auth/me` returned 200 and agrees with the database:
- user `7e9c7d25…`, organisation `0e4c107d…` ("Platform");
- roles `["ceo"]`, `isPlatformAdmin: true`;
- workspace `aed5921c…` (`issac`), READY, with an active membership;
- application target `manager_web`; not an Admin Inspect session.

| Request | Status | Refused by | Required flag | Present in the CEO role? |
|---|---|---|---|---|
| `GET /job-roles` | 403 "You do not have access to this…" | `PermissionGuard` | `schedule.view` | no |
| `GET /staff?limit=1` | 403 | `PermissionGuard` | `staff.view` | no |
| `GET /managers?limit=1` | 403 | `PermissionGuard` (class-level) | `manager.manage` | no |
| `GET /staff?sort=createdAt&direction=desc&page=1` | 403 | `PermissionGuard` | `staff.view` | no |

- **What the CEO role held:** 4 permissions: `attendance.edit`, `report.export`, `role.manage`, `role.view`. Its code definition (`ROLE_DEFS[ceo]`) has 33.
- **What the catalogue held:** `core.permission` contained **6 of the 43** `PermissionFlag` keys.

## 2. One root cause

All four 403s have the same cause: **the migration chain never creates the permission catalogue.**

- **How the catalogue is filled:**
  - only the dev-only `seed` command (which also creates a demo organisation and admin) and `seed-qa` insert the `PermissionFlag` rows;
  - the migrations insert just 6 keys.
- **How roles are created:** every system-role path intersects the role's defaults with whatever the catalogue holds and carries on silently:
  - `ManagerService.ensureRole` (CEO, Manager, Venue Manager);
  - `StaffService.ensureStaffRole`;
  - the `bootstrap-admin` command.
- **Result:** on a database built from migrations, the CEO got 4 of its 33 permissions. **The Staff role would fail too:** `offer.respond` and `payslip.view_own` are missing as well, so staff couldn't accept offers.

**Ruled out, each checked:**
- Admin Inspect: the session isn't inspecting.
- Mobile default-deny: the target is `manager_web`.
- Missing workspace: the workspace is READY and the membership active.
- Stale cache: a fresh login gives the same result.
- A missing function grant: the posture matches the golden snapshot.
- An old image or an incompatible schema: 172 migrations, built from your working tree today.

## 3. Why it came back after rebuilding

- **The old development database had been seeded by hand once,** so its catalogue was complete and the defect was hidden.
- **Today's clean install** (172 migrations, deliberately no demo seed) produced the 6-key catalogue, and `bootstrap-admin` then created a crippled CEO role. **Any future clean database would do the same.**
- **The tests couldn't catch it:** the integration test factory `ensurePermissions` **inserted any missing catalogue row**, silently repairing the defect in every test run.

## 4. Platform Admin's operational workspace

**Yes, it has one, and it's legitimate:**
- workspace `issac`, owned by you, created through onboarding;
- membership `active`;
- `manager_profile` of type `ceo` bound to it.

**No membership or privilege was invented.** The only defect is the role's missing default permissions.

## 5. Requests before and after

| Request | Before (live dev, today) | After (copy of your dev database with the migration, real API, same account) |
|---|---|---|
| `GET /job-roles` | 403 | 200 `[]` |
| `GET /staff?limit=1` | 403 | 200 `{"data":[],"total":0}` |
| `GET /managers?limit=1` | 403 | 200 (lists the account) |
| `GET /staff?sort=createdAt&direction=desc&page=1` | 403 | 200 `{"data":[],"total":0}` |

**Fresh migrations-only database, after the fix:**
- the bootstrap admin's CEO role gets all 33 permissions;
- without a workspace, `/staff` and `/job-roles` return 404 "Not found" (the existing no-workspace behaviour) and `/managers` returns 200;
- after creating and provisioning a workspace, all four return 200.

## 6. Files changed

**Server, `packages/rab-server/src/`:**
- **New migration:** `database/typeorm/core/migrations/1786718000000-PermissionCatalogueAndSystemRoleDefaults.ts`.
- **New helper:** `modules/identity/services/system-role-permissions.ts` (`loadSystemRoleDefaultPermissions`, fail-closed).
- **Changed to fail closed:**
  - `modules/manager/services/manager.service.ts` (`ensureRole`, both paths);
  - `modules/staff/services/staff.service.ts` (`ensureStaffRole`);
  - `command/bootstrap-admin.command.ts`.
- **Tests:**
  - `__tests__/integration/helpers/test-identities.ts`: the factory **reads** catalogue rows and never creates them;
  - new `__tests__/integration/permission-catalogue-operational-access.integration.spec.ts`;
  - new `database/typeorm/core/permission-catalogue.spec.ts`.

**Web, `packages/rab-front/src/`:**
- `shared/table-toolbar/ListPresentation.tsx`: `ListError` gains an `error` prop; new `listErrorStatus` and `useRetryUnlessPermanent`.
- `features/users/Users.tsx` and `features/users/Users.spec.tsx`.

**Also earlier today:** `migration-identity.ts`, `core.datasource.ts` and the compose changes (see `DOCKER_FACTORY_RESET_AND_CLEAN_INSTALL_REPORT.md`).

## 7. The migration (`1786718000000`, prepared, applied only to disposable databases)

**What it does:**
1. **Catalogue:** upserts all 43 `PermissionFlag` keys (`ON CONFLICT (key) DO NOTHING`). The frozen list is checked against `PermissionFlag` by a unit test, so a new flag can't ship without a migration.
2. **System-role repair:** for each organisation, with its own tenant context bound (the FORCE RLS pattern from `1786717600000`), it grants each **org-level system** role (`ceo`, `manager`, `venue_manager`, `staff`) the **code defaults it is missing**.
   - **It only adds a role's own defaults.** System roles are read-only in the role editor, so a missing default can only be this defect, never an admin's deliberate choice.
   - **It bumps `permission_version`** on every repaired role, so cached authorisation snapshots are dropped.
   - **Untouched:** custom roles, workspace roles, `platform_admin`, memberships and users.
3. **Self-verification:** it refuses to be recorded if any key is still missing. `down()` is a deliberate no-op.

**Rehearsals:**

| Rehearsal | Result |
|---|---|
| Fresh database from migrations only (phase A as `rab_owner`, then bootstrap) | 173 migrations, catalogue 43, CEO 33/33 |
| Copy of your current dev database (`pg_dump`, restored into a separate cluster) | migrations 172 → 173; catalogue 6 → 43; CEO permissions 4 → 33; `permission_version` 1 → 2. Users, memberships, platform admins and workspaces unchanged |

## 8. Permission and RLS verification

- **Posture:** fresh databases match the golden posture.
- **RLS:** FORCE RLS on `role` and `role_permission` is preserved; the repair binds tenant context per organisation.
- **Platform-admin boundary:**
  - a platform admin still can't see another organisation's managers: 404, absent from the list;
  - without a workspace, data requests are 404, not 403, and never another tenant's data.
- **No blanket override:** `isPlatformAdmin` was not turned into a permission override.

## 9. Redis cache

- **Same-session recovery (integration test):** a live session of a crippled CEO, after the repair migration, gets **200 on the same session**, because the `permission_version` bump invalidates its cached snapshot.
- **Existing Redis suites** (auth-context, user-session, member-role Redis cache, cross-instance invalidation) all pass against the disposable test database with real Redis.

## 10. Docker build and startup

- The images are rebuilt from your working tree and contain the migration and the fail-closed code.
- The running `rab-server`, `rab-worker` and `rab-provisioner` containers still run the previous image until they're recreated.
- Nothing starts migrations automatically; the migration runs only through the `migrate` job.

**Why a rebuild can't bring this back:**
- the catalogue is now part of the migration chain;
- role creation refuses to mint a crippled role;
- the test factory no longer masks a missing catalogue;
- a unit test fails if `PermissionFlag` or `ROLE_DEFS` drift from the migration.

## 11. Front-end corrections (`Users.tsx`)

| Situation | What the page now does |
|---|---|
| Request failed or still loading | Tab counts and the record footer are **hidden**. "Staff · 0" appears only after a successful load. |
| 403 | "You don't have permission to view these records." No Retry, no automatic retries, no "New staff". |
| 404 | "No operational workspace is available for your account yet." No Retry. |
| Temporary error | The original message with Retry, using the app's normal retry policy. |
| Empty list (200) | Shows `Staff · 0` and the New staff action. |

## 12. Tests

| Suite | Result |
|---|---|
| New: `permission-catalogue-operational-access` (6) | 6/6. Covers the catalogue from migrations, a Platform-Admin CEO with and without a workspace, cross-organisation 404, fail-closed creation, and the repair with same-session recovery |
| New unit tests: `permission-catalogue.spec` (3) and `migration-identity.spec` (7) | 10/10 |
| Server, full suite, 3 workers, migrations-only test database | 1,713 passed, 19 failed, 61 skipped. 12 failures are the documented baseline (`hws-backfill` 9, `identity-security-table-rls` 2, `audit-log-immutable-identifiers` 1). `containment-suspend-test-accounts` (5) and `google-oauth-handoff` (2) fail only in parallel runs and pass alone (5/5, 23/23). |
| Web, full suite | 473/473, including 4 new Users-state tests |

**Covered by the existing suites, all passing on the migrations-only database:**
- organisation isolation;
- Admin Inspect read-only;
- mobile default-deny;
- platform-admin promotion and demotion sessions;
- workspace membership revocation;
- Redis cache on and off;
- account invitations;
- the Initial Manager flow;
- cross-organisation manager IDs.

**New disposable test infrastructure** (built from migrations, not shared with dev):
- `crewflow-test-db` on 127.0.0.1:15436, with the test marker;
- `crewflow-test-redis` on 127.0.0.1:16391.

## 13. Second rebuild or restart

- **Proven on disposable databases:** a database built twice from the migration chain gets the full catalogue both times.
- **The live restart test on dev** (rebuild, `compose down`/`up`, then the four requests and the ledger) runs **after you approve applying the fix**.

## 14. Owner decisions

1. **Approve applying `1786718000000` to `rab-devdb`.** I will:
   - take a backup;
   - run the `migrate` job with the bootstrap identity;
   - recreate the API, worker and provisioner from the rebuilt images;
   - verify the four requests in the browser, the same-session recovery and the restart.
2. **Keep or remove the disposable test database and Redis** (ports 15436 and 16391).

## 15. Applied to the development database (2026-10-16, owner approved)

1. **Backup:** `C:\Crewflow-Docker-Archive\20261016T070342Z-pre-1786718000000` (`rab-devdb_rab.dump` plus globals, with a SHA-256 manifest; 1,218 table-of-contents entries).
2. **Migration:** `migrate` job with the bootstrap identity, against cluster 7697007843365589026.
   - migrations 172 → 173;
   - catalogue 6 → 43;
   - CEO permissions 4 → 33;
   - `permission_version` 1 → 2;
   - users and workspaces unchanged.
3. **Services:** `docker compose up -d` recreated server, worker and provisioner from the rebuilt images.
4. **Requests, as `issac@gmail.com`:** all 200: `/managers`, `/offers`, `/staff` (all variants), `/job-roles`, `/shifts`, `/venues`.
5. **Restart:** after a full `compose down` / `up`, with no migration job run, the ledger, catalogue and role are unchanged, and the **same session** still gets 200 on every endpoint.
