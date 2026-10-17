# Docker factory reset and clean install — report

Date: 2026-10-15. Scope: local Docker Desktop (`desktop-linux` context, WSL2 engine 29.8.1) only. Nothing committed,
pushed or deployed. The repository (all 311 uncommitted changes) and the external archive are untouched.

## Verdict: PARTIAL

| Area | Status |
|---|---|
| External backups (verified restore) | Done |
| Docker wipe | Done (deleted by you; I verified the result) |
| Fresh schema initialised under the documented role sequence | Done |
| Security posture equal to the golden snapshot | Done |
| Five-service stack healthy | Done |
| Restart performs no migration | Done |
| **First sign-in** | **Not possible yet:** the new database has zero accounts on purpose |

**Two decisions are open (section I):**
- the first administrator invitation;
- whether to enable the opt-in workspace provisioner.

---

## A. Original environment (before the reset)

**Inventory:** saved in `C:\Crewflow-Docker-Archive\20261015T205541Z\docker-inventory\`.

**Size:**

| Resource | Count | Size |
|---|---|---|
| Containers | 40 (15 running) | |
| Images | 29 | 16 GB |
| Volumes | 46 | 6.7 GB |
| Build cache | | 35.6 GB |

**Compose projects:** `rab`, `rab-qa`, `rab-crm`. Other volumes found: `rab-crm-dev`, `leopardo-hr`, `rab-production` (Redis), 15 anonymous volumes.

**Classification:**
- **Crewflow:** the active stack, the retired database pair, and QA, audit, test and restore databases.
- **Unrelated:** `rab-crm` (`C:\Rab-CRM`, `restart=always`), `rab-crm-dev` and `leopardo-hr`.
- **Unknown:** five unlabelled Postgres volumes.

## B. Backup evidence

**Archive:** `C:\Crewflow-Docker-Archive\20261015T205541Z\`

- **Size:** 987 MB in 97 files.
- **Access:** inheritance is removed and only `RAB\issac`, SYSTEM and Administrators have access.
- **Checksums:** all in `checksums\SHA256SUMS.txt`; the manifest's own SHA-256 is `bdd18b66…`.
- **Recovery steps:** `recovery-instructions\README.md`.

**Live database (`rab-devdb`, cluster 7696906180229607458):**
- **Writers stopped:** the backup was taken with API, worker, provisioner, front end and Adminer stopped and 0 database clients connected.
- **Files:**

  | File | Size | SHA-256 |
  |---|---|---|
  | `postgres\rab-devdb_rab.dump` | 11,184,612 B | `3f1ec725…23c3` |
  | `postgres-globals\rab-devdb_globals.sql` | 2,030 B | `122db7b5…c639` |
  | `postgres\rab-devdb_postgres.dump` | 1,022 B | `046b6bf7…fcdfcd` |

- **Source state:** 168 migrations, 476 users, 432 organisations, 265 workspaces, 321 sessions, 334 refresh tokens, 1,463 audit rows.

**Restore test:**
- restored into an independent cluster, `7697001991123394594`;
- roles restored with one expected error ("role rab already exists");
- `pg_restore --exit-on-error` exited 0 with an empty error log;
- the **41,095-line catalog and data fingerprint is byte-identical** to the source. It covers roles and memberships, ownership, function privileges, RLS ENABLE/FORCE, 1,468 policies, sequences, triggers, foreign keys, extensions, the ledger and a content hash of every table.

The test infrastructure was removed after the evidence was saved.

**Every other data volume:**
- **8 running test and audit Postgres instances:** logical `pg_dumpall`.
- **18 stopped or unattached Postgres volumes:** an unmodified, read-only raw `tar` plus a logical dump taken from a temporary server on a **copy**. The original volumes were never written and never mounted by two servers.
- **The retired shared volume:** raw only, never started. It is covered by the earlier verified logical dumps, which were copied in and match their original checksums.
- **Redis:** `SAVE`, then a raw tar.
- **MinIO and app storage:** raw tars.
- **Integrity:** every gzip and tar passed its integrity test.

**Not archived:**
- `node_modules` caches (reinstallable);
- three empty volumes.

## C. Destructive reset

**Who did it:** you deleted every container, image and volume yourself, after the checkpoint where nothing had been deleted. That included the unrelated `rab-crm`, `rab-crm-dev` and `leopardo-hr` data, all of which is in the archive.

**Verified afterwards:**
- 0 containers, 0 images, 0 volumes;
- only the `bridge`, `host` and `none` networks;
- the archive intact (97/97 files verify);
- the repository unchanged.

**Build cache:** I pruned everything older than one hour, removing the old 35.6 GB. About 16 GB from today's builds is kept so rebuilds stay fast.

## D. New infrastructure (compose project `rab`, `packages/rab-docker/docker-compose.yml`)

| Service | Container | Image | Host port | Notes |
|---|---|---|---|---|
| devdb | `rab-devdb` | postgres:16-alpine (16.15) | 127.0.0.1:15432 | New volume `rab_devdb_data`, **cluster 7697007843365589026**, data checksums on, `container_name` prevents a twin |
| redis | `rab-redis-1` | redis:7-alpine | none (internal only) | Fresh, empty |
| server | `rab-server-1` | `rab-server` (built from your working tree) | 127.0.0.1:3000 | `main.js` only, runtime role `crewflow_app` |
| worker | `rab-worker-1` | `rab-worker` (built from your working tree) | none | `main.js` only, runtime role `crewflow_app` |
| front | `rab-front-1` | node:24-alpine (Vite) | 127.0.0.1:5173 | API `http://127.0.0.1:3000/rest/v1` |

**Opt-in profiles, not started by default:**
- `migrate`, the explicit migration job;
- `provisioner`, new: the workspace-schema provisioner, the only holder of `crewflow`;
- `tools` (Adminer, now on loopback);
- `s3` (MinIO).

**Credentials:**
- **No hardcoded application or superuser passwords.** Random development secrets are in `packages/rab-docker/.env`, which is git-ignored and never printed.
- **Remaining dev-only passwords:** `postgres-init/01-roles.sql` still contains the historical dev passwords for `rab_owner` and `rab_app`. Both roles are now `NOLOGIN`; the migrations retired them.
- **Runtime roles:** `crewflow_app` and `crewflow` are not superuser and do not bypass RLS. `rab` is the bootstrap superuser, used only by the migration job.

**Network:** one bridge network, `rab_default`. Only `crewflow_app` connections reach Postgres.

## E. Migration controls

- **No startup migrations:**
  - **API and worker:** run `main.js` and hold no migration credential (`DATABASE_URL_UNPOOLED` is empty).
  - **`start.sh`:** no default service uses it.
  - **Migration job:** migrations run only via the `migrate` profile, which needs `CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations` and a privileged URL.
- **Migration set applied:** all 172, the 168-migration baseline plus `1786717600000`–`1786717900000`.
  - At the checkpoint I recommended this set as the only one proven to work for the current code: the email-change service needs `…7800000`, and `…7700000` fixes the CF-09 grant gap on fresh builds.
  - You then said "run the system now", and I took that as approval of the recommended set. **If you meant otherwise, say so: the new database is empty and can be recreated in minutes.**
- **Identity sequence:**
  - **Phase A,** as `rab_owner`: 128 migrations. The run stopped at the role split, as designed.
  - **Phase B,** as the bootstrap superuser: 44 migrations, ending at `DatabaseDefenceInDepth1786717900000`.
- **Bug found and fixed in the CF-41 identity guard** (my own code from earlier today):
  - **The bug:** at the A/B boundary it refused the superuser even though phase A was complete. That blocked every fresh install.
  - **The fix:** it now refuses a superuser only while pre-split migrations are still pending. A superuser-built phase A, the case it exists to stop, is still refused.
  - **Files:** `migration-identity.ts` and `core.datasource.ts`, plus 2 new tests (7/7 pass).
  - **Images:** rebuilt before phase B.
- **Security posture:** **matches the golden snapshot (562 lines).** RLS coverage OK, 48 tenant tables, checked as `crewflow_app`.
- **Ledger before and after a full `compose down` / `up`:** 172 entries, md5 `9e76b6e3…`. The 1,866-line schema-and-ledger fingerprint is byte-identical.
- **Further migration approval:** none needed.

## F. Empty database

| Records | Count |
|---|---|
| Users | 0 |
| Organisations | 0 |
| Workspaces | 0 |
| Managers | 0 |
| Staff | 0 |
| Venues | 0 |
| Shifts | 0 |
| Offers | 0 |
| Attendance | 0 |
| Sessions | 0 |
| Refresh tokens | 0 |
| Invitations | 0 |
| Platform admins | 0 |
| Audit log | 0 |

**System metadata only:**
- 6 permission-catalogue rows;
- 172 migration-ledger rows;
- schemas, functions, RLS policies and grants.

**Nothing old was restored:** no data, sessions, Redis queues or demo accounts.

## G. Application verification

- **Health:**
  - `GET /healthz` returns 200 with the database up;
  - the worker reports `rab-worker ready` with 0 restarts;
  - Redis is in use (14 clients);
  - the front end is healthy.
- **Unauthenticated API checks** (`scratchpad/clean/smoke.txt`):

  | Probe | Result |
  |---|---|
  | Unknown login | 401, generic message |
  | `organisationId` in the body | 400, refused, never accepted |
  | Bad application target | 400 |
  | Unissued session cookie | 401 |
  | Invalid refresh token | 401 |
  | Forged bearer token | 401 |
  | `/staff` and `/managers` without auth | 401 |

- **Browser:**
  - `http://localhost:5173/` redirects to `http://127.0.0.1:5173/login`, so the cookie-host mismatch is avoided;
  - the login page renders;
  - wrong credentials show the red "The email or password is incorrect…" message;
  - no session cookie is set;
  - the only console messages are the expected anonymous 401s;
  - screenshots are in `docs/qa/clean-install/`.
- **Login bootstrap:** **pending.** There are no accounts, so a real sign-in can't be demonstrated yet.

## H. Resource usage (measured)

**At idle:** 5 containers.

| Container | Memory | CPU |
|---|---|---|
| server | 197 MiB | 0% |
| worker | 238 MiB | 0.2% |
| front (Vite) | 370 MiB | about 20%, during its initial warm-up |
| devdb | 38 MiB | 0.1% |
| redis | 6 MiB | 0.4% |
| **Total** | **about 850 MiB** | |

**Docker disk:**

| Resource | Count | Size |
|---|---|---|
| Images | 5 | 3.8 GB |
| Volumes | 3 | 0.87 GB |
| Build cache | | 16 GB |

## I. Remaining blockers and owner decisions

1. **First administrator** (blocks sign-in). I can run the existing `bootstrap-admin` command, which creates an INVITED platform admin with **no password**. You activate it through the link printed in the worker's email log. I need your approval and the email address.
2. **Workspace provisioner.** Without it, a workspace created during onboarding stays "Still preparing…". It's in compose behind `--profile provisioner` because it holds the privileged `crewflow` credential. Should it run by default?
3. **Migration set:** confirm that all 172 (section E) was what you intended.
4. **Not configured** (not needed for local development):
   - **Email:** `LOGGER` driver only, so no real email is sent.
   - **File storage:** local driver, not the shared MinIO/S3 store.

**Compose and guard changes this session** (uncommitted):
- `packages/rab-docker/docker-compose.yml`;
- `packages/rab-server/src/database/typeorm/core/migration-identity.ts` (+ its spec);
- `core.datasource.ts`.
