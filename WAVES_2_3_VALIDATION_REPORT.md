# Waves 2+3: integration, validation and dev rollout

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation` (local only, nothing pushed). Lanes integrated: S2 (schema),
A2 (auth keys/cookies), H (workspace host routing). Nothing touched production, Neon, Cloudflare or DNS. The owner's account
`issac@gmail.com` was not used: no login, password or session change. **Evidence:** `docs/evidence/waves-2-3-validation/`
(git-ignored, like all of `docs/`).

**Verdict: PASS.** The combined tree typechecks. Every test failure is on the known pre-existing list. The dev stack runs
the new images with host routing on, and the smoke checks behave as designed. One expectation differed from the design
(§6, `api.localhost`). It is documented below and is not a defect.

## 1. Commits (local, on top of `e276c8d2`)

| Commit | Content |
|---|---|
| `b91f088c` feat(db) | Lane S2: 3 migrations, migrator/ledger, drift job, money CHECKs, namespace SQL, tests, report |
| `09a1b2ba` feat(auth) | Lane A2: keyring.util, JWT `derived-v1` and rotation helper, cookie policy and `__Host-` migration, SECURITY.md, report |
| `59989de0` feat(workspace-host) | Lane H: engine `workspace-host/`, registry-backed trust, manager-workspace changes, shared `hostname.ts`, web gate, Vite, report |
| `e12c3f79` fix(integration) | Files both A2 and H edited, in their combined state (env.validation(+spec), environment-variables, environment.service(+spec), `.env.example`, worker-bundle `JOBS_ENV_KEYS`, cookie-csrf spec, THREAT-MODEL.md); the regenerated golden; migration `1786719830000` |
| `e8560629` chore(docker) | Dev compose: host routing and origin trust on, front calls the API same-origin through the proxy |

- **Left uncommitted, as the owner asked:** `packages/rab-docs/tools/**`, `skills-lock.json`, the 3 deleted `CREWFLOW_*`
  reports, and the `rab-iphone` docs.
- **Secret scan:** each staged diff was scanned. The only hit was a fixture constant in the A2 specs, and it matches no real
  environment value.

## 2. Integration fixes

- **Cross-lane conflicts.** With the lanes combined, the failures A2 reported (env.validation, environment.service,
  cookie-csrf, origin-trust, launcher test 14) are gone:
  - the overlap unit specs pass together (23 suites, **408/408**);
  - the launcher passes 18/0/12 on Windows and **30/30 in the image**.
- **H's edits to lane-A specs keep their security intent, and make it stricter:**
  - with trust on, an unregistered shape-valid label (`ghost`) is now refused;
  - reserved, `http`, other-port and look-alike origins are refused even when the registry has "confirmed" them;
  - the CORS and `/auth/refresh` refusals are unchanged.
- **SECURITY.md:** A2's boot-refusal paragraph sat inside the secrets table and split it in two. It now follows the table.
- **New migration `HostLabelResolverDisplayName1786719830000`** (dev/test only, not in `production-migration-approval.ts`):
  - It appends `display_name` (= `manager_workspace.name`) as a fifth OUT column of `core.resolve_workspace_by_host_label`.
    The IN signature and the first four columns are unchanged.
  - It drops and re-creates the function in one transaction. Owner, DEFINER, `search_path` and ACL are re-applied (EXECUTE
    `crewflow_app` only). The migration **refuses unless the ACL equals the one it replaced**.
  - `down()` restores the earlier body. A down→up rehearsal in a rolled-back transaction gave the same ACL
    (`testdb/08`).
  - H's lookup, the public endpoint and the login page already read the column.
  - **Tests:** the S2 namespace spec now asserts the 5-column row. H's real-function contract spec asserts `displayName`
    and checks the public response holds no ids. It also gained **an abuse case**: A's session on B's real READY host →
    `404 WORKSPACE_HOST_MISMATCH`, with no B label or name in the body, while A's own host returns 200.
  - **THREAT-MODEL** entry added (the workspace name is disclosed pre-auth).

## 3. Fresh test DB and golden

- **`crewflow-test-db` recreated** with the requested settings: postgres:16-alpine, data checksums,
  `max_locks_per_transaction=256`, `unless-stopped`, init scripts mounted read-only.
- **Migrations:**
  - phase A as `rab_owner` stopped at the role split by design (128 applied);
  - phase B as the superuser exited 0, for a total of **200 migrations**.
- The `crewflow.disposable_test_database` marker is set. Test Redis was flushed.
- **Golden** (`check-db-security-posture.ts --write`):
  - drift against HEAD was **80 unexpected lines, 0 missing**, byte-identical to S2's `golden.diff`;
  - after the write, the diff against HEAD equals `golden.diff`;
  - the new migration adds 0 lines;
  - the result is 1148 lines, and the workspace section is unchanged.
- **Checks:** posture OK, RLS coverage OK (58 tables). rab-devdb, which has 1 real workspace, also matches the new golden.

## 4. Tests (sequential, fresh DB)

| Suite | Wave 1 | Now | Failures |
|---|---|---|---|
| rab-shared | 77 | **113/113** | none |
| rab-ui | 2 | **2/2** | none |
| rab-front (`--maxWorkers=4`) | 678 | **683/683** | none |
| rab-server unit (`--maxWorkers=4`) | 634/637 | **816/819** (60 suites) | tenant-context ×3 (known) |
| rab-server integration (`--runInBand --forceExit`, `HOST_LABEL_CONTRACT_DB=1`) | 1569 / 3 / 61 (129 suites) | **1672 / 3 / 61** (135 suites) | identity-security-table-rls ×2, shift-team ×1 (known) |
| rab-worker (`TEST_DATABASE_CREWFLOW_URL`) | 431 / 10 / 13 | **431 / 10 / 13** | member-invitation-delivery W1–W9, 91-day token cleanup (known) |
| rab-mobile `flutter test` | 652 | **652/652** | none |
| worker-bundle launcher, in the new `rab-worker` image | 30/30 | **30/30** | none |
| `tsc`, 7 projects | 6 exit 0 | 6 exit 0 | rab-utils TS18003 (known) |
| `yarn lint` | rab-utils, `rab:lint` recursion | same | known |

- **New suites on real functions:** host-label-registry-contract 5/5, workspace-host-routing 40/40, host-label-namespace
  9/9, workspace-schema-migrator 11/11, constraint-regression 20/20, wave2-auth-cookies-keys 18/18, origin-trust 9/9.
- **How the integration total was reached.** The first full run showed 29 failures. They break down as follows:
  - **26 environmental:** identity-security-table-rls timed out in `beforeAll` (5 s) on a cold start, so all 28 of its
    tests failed.
  - **2 suites self-inflicted:** I ran `yarn lint` concurrently. Its nx build/cache restore rewrote
    `rab-shared/dist-cjs`, `rab-emails/dist` and `rab-server/dist` mid-run (ENOENT in performance-baseline and
    user-deletion).
  - **Fix:** I rebuilt the dists and re-ran those 3 suites alone (`tests/22`). Results: identity-security has its known
    2 failures (26 pass), user-deletion passes, and performance-baseline is opt-in (skipped).
  - **Lesson:** never run `yarn lint` alongside tests.
- `tests/21-rab-server-integration.json` contains test-fixture JWTs. Do not share it.

## 5. Dev rollout (rab-devdb, TEST database)

- **Identity, read-only and checked twice:** system id `7699569147858477090`, 199 migrations.
- **Backup:** `C:\Users\issac\crewflow-db-backups\rab-devdb-20261023-044952-pre-waves-2-3-display-name.dump`.
  - Size 957,471 B, sha256 `5386c510c6a505e3a6dd9b62587a80be48f4b7ca3f74ad5461d7747b14db4ec9`.
  - Restore-tested in a throwaway container: `pg_restore` exit 0, identical counts.
- **Migration:** the guarded runner, `DB_TARGET=local`, the bootstrap superuser from `packages/rab-docker/.env` (never
  printed). It applied `HostLabelResolverDisplayName1786719830000`, for a total of 200. The resolver ACL is unchanged.
- **After the migration:** posture matches (1148 lines, 1 workspace matches the template), RLS coverage OK (58 + 21
  workspace tables), drift `checked=1 ok=1`.
- **Images:** built one at a time. Server `5c243bff`, worker `cf625877` (were `01b6b810` / `f5e869b4`).
- **Restart:** `up -d --no-deps server worker front`, and all three are healthy.
- **Guards:**
  - api `crewflow_app`;
  - jobs `crewflow_app`;
  - provisioner `crewflow`;
  - "live identity probes agree … (jobs=crewflow_app, provisioner=crewflow)".
- **Drift job** ran at start-up, alert-only: `checked=1 ok=1 findings=0`.
- **Flags** are present in the server, in the worker jobs child, and in the front (`VITE_API_URL=/rest/v1`, proxy
  `http://server:3000`).
- **Logs:** 0 error or warning lines in server, worker and front after the smoke tests.

## 6. Smoke tests (`smoke/`, curl, no owner credentials)

| Check | Result |
|---|---|
| `GET http://issac.localhost:5173/` | 200, the SPA shell |
| Resolver through the proxy, Host `issac.localhost:5173` | `workspace`, subdomain `issac`, displayName `issac`, canonical `http://issac.localhost:5173` |
| `unknown-w23.localhost:5173` | `not-found` |
| `api.localhost:5173` (reserved) | **`default`**, not `not-found`. This is H's design (§1): a reserved *Host* label is treated as the default host, because the API may live there. It is never trusted: preflight gets no ACAO, and login gets 403 |
| `127.0.0.1:5173`, `localhost:5173` | `default` |
| Upper-case Host | the same workspace |
| Spoofed `X-Forwarded-Host` from an untrusted peer | ignored (`default`) |
| CORS preflight to `:3000` | **allowed:** `issac.localhost:5173`, `127.0.0.1:5173`, `localhost:5173`. **Refused (no ACAO):** `evil.localhost`, unknown labels, `api.localhost`, port 5174, https, `evil.example` |
| Login provenance, synthetic email | 403 from evil/api origins; a uniform 401 from `issac.localhost` |
| Owner login path | `127.0.0.1:5173/login` 200; `/auth/me` 401 "Missing credentials"; login with a synthetic email 401 "Invalid email or password." through the proxy |
| Authenticated wrong host | **Not done on dev, because there is no self-signup.** A second user or workspace needs the owner's admin session or direct DB writes to the owner's dev data. The case is instead proven on real functions and real sessions in the contract suite (§2), plus routing 40/40. On dev, forged and absent cookies from workspace or unknown hosts get the ordinary 401 |

**For the owner:** Chrome and Edge resolve `*.localhost` automatically.
- Open **http://issac.localhost:5173** for the workspace host. Sign in there once: each host has its own cookie.
- **http://127.0.0.1:5173** stays the default console. Existing 127.0.0.1 sessions should continue.
- `localhost:5173` no longer redirects to 127.0.0.1.
- Dev caveat: the API now sees every browser request from the front container's IP, so the per-IP route throttles are shared
  in dev. Dev only.

## 7. Owner decisions (collected)

**S2**
1. Revoke `crewflow_app` INSERT/UPDATE/DELETE on `workspace_schema_registry`.
2. Retention of the quarantine and ledger history (both kept forever today).
3. The quarantine length (90 days).
4. Gate G3: fail-closed routing on drift.
5. The CLAUDE.md NOT-FORCE list is stale: it should read 12 + `organisation` / `platform_admin`.
6. Production approval of `1786719800000`, `…810000`, `…820000` and `…830000`.

**A2**
1. `AUTH_COOKIE_HOST_PREFIX_ENABLED` in production. Then, after about 30 days, set the migration flag to false.
2. A console domain that is a sibling of the API, so SameSite can become Lax.
3. A dedicated JWT keyring and cache key, then `APP_JWT_LEGACY_VERIFY_ENABLED=false` and
   `APP_KEY_SEPARATION_REQUIRED=true`.
4. Two trade-offs: raw keyring kids, and `Path=/` on the refresh cookie. Also: should we stop issuing `rab_rt` to web?
5. QR and legacy-encryption keys stay rooted in APP_SECRET.
6. Optional: a `rotate_web_session_token` DEFINER function.
7. **Confirm the production APP_SECRET passes the weak-key check before any deploy.**

**H**
1. The production base domain (a `workspaces.` sub-zone), and the two flags, enabled separately.
2. Topology: a fixed API host vs a same-origin proxy.
3. Should sign-in on a wrong host be refused up front?
4. Rename rate and per-workspace cap.
5. A public display name is now implemented in dev, so confirm it for production. Also decide on a logo.
6. Should the default host auto-redirect to the canonical host?

**Integration:** accept that a reserved Host label (`api.<base>`) is served as the default host rather than `not-found`.
