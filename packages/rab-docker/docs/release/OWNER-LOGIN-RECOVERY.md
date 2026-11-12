# Owner-login deployment: recovery and rollback

**Status (2026-11-04).** Owner-approved, and required before the final clean-up PR (#9).

The evidence is Agent 1's rollback proof on disposable PostgreSQL 16.15:
- **old code:** main `db498fb4` (the separated deployment);
- **new code:** `deploy/twenty-mode-a` `e6c768f3` (the owner login).

Runs **R1** and **R2** are summarised in section 5. Each statement below is marked **PROVEN** (that run), **VERIFIED** (the old code's own gate function), or **NOT TESTED**. No real provider resource was used.

Release procedure, transition and approval token: [`OWNER-LOGIN-DEPLOYMENT.md`](OWNER-LOGIN-DEPLOYMENT.md), sections 3 and 5.

---

## 1. The rule

**The supported rollback is a RESTORE, then the previous image:**
1. Restore the backup or PITR point taken **before** the upgrade.
2. Deploy the previous image digest, with its previous configuration.

**How an image rollback runs (owner decision 2026-11-11, like Twenty):** set `CREWFLOW_IMAGE_TAG=<previous digest>` in
`compose.env`, then run the same one command as a deploy, `docker compose pull && docker compose up -d`. The API and the
Worker go back together, from the same digest: Compose stops the Worker, replaces the API, and starts the Worker once the
API is healthy. Never roll back the API alone while a newer Worker keeps running. Without a restore this is safe only
between owner-login releases whose pending sets were reviewed as expand-only (`OWNER-LOGIN-DEPLOYMENT.md` §3.6a): the
older API then logs that the schema is AHEAD and serves.

R2 proved this (section 5). Do not start an old image on an upgraded database and hope. In production that **fails closed** (section 3); in development it runs with warnings, which proves nothing about production.

**The legacy logins are disabled after the transition (BC-17, Agent 1).** Once `transition-from-separated.sql` has run, `crewflow` and `crewflow_app` become **NOLOGIN with PASSWORD NULL**; `crewflow_worker` stays LOGIN (two existing migrations assert it) but gets **PASSWORD NULL**, so it has no password to authenticate with; `crewflow_migrator` (if your deployment has it) becomes NOLOGIN with PASSWORD NULL at the transition (Agent 1, f91f1038): it keeps its role memberships but cannot log in, and a fresh owner-login install never creates it. A fresh owner-login install ends in the same state. The old image cannot connect even before any owner-login migration applies.

> **MANDATORY PRECONDITION (MIX-1): one separated Crewflow deployment per cluster.** Run the transition only on a cluster that hosts no other separated Crewflow deployment. The legacy logins are cluster-wide roles, and disabling them breaks every database on that cluster that still uses them (staging, QA or another stack on the same server).
>
> **Check first**, as the provider admin, read-only. `<db>` is the database you are about to transition:
> ```sql
> -- 1. Every database on the cluster.
> SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;
> -- 2. Live sessions of the legacy logins on ANY other database (must return no rows).
> SELECT datname, usename, count(*) FROM pg_stat_activity
>  WHERE usename IN ('crewflow','crewflow_app','crewflow_worker','crewflow_migrator') AND datname <> '<db>'
>  GROUP BY 1, 2;
> ```
> Then, for **every other** database from query 1, confirm that it is not a Crewflow database (each check must print `f`):
> ```bash
> for d in <other databases from query 1>; do
>   printf '%s: ' "$d"; psql "<admin URL of database $d>" -X -At -c "SELECT to_regclass('core.migrations') IS NOT NULL"
> done
> ```
> **If any other database is a Crewflow database, or any legacy-login session appears: STOP.** Move that deployment to its own cluster, or transition it too, before you run the transition here. Query 2 only sees processes connected at this moment, which is why the per-database check is required as well.

**What brings them back.** Role attributes and password verifiers are **cluster-wide**: they live in `pg_dumpall --roles-only`, not in `pg_dump`.
- **Self-hosted:** only a restore into a **FRESH** cluster of the `roles.sql` file taken before the transition, **plus** the database dump, brings back LOGIN and the old password verifiers. That is the proven R2 path (§4.1).
- **A database-only `pg_restore` into the same cluster does NOT restore role attributes.** The roles keep their post-transition state (NOLOGIN, PASSWORD NULL), and the old image still cannot connect.
- **Managed provider:** the restored NEW instance carries its own roles from the restore point (§4.2).

That is one more reason the backup in §2 (both files) is mandatory.

The expand-only image rollback in `OWNER-LOGIN-DEPLOYMENT.md` §3.6a stays available **only between owner-login releases whose pending sets were reviewed as expand-only**. It is **not** a way back from the separated → owner-login transition. That transition's migrations change grants, policies and the provisioning function, and the old code refuses them in production.

## 2. Mandatory prerequisite: the backup or restore point comes FIRST

Before **`transition-from-separated.sql`** (Agent 1), or before the **first owner-login migration** on any existing database, take one of the following. Record it in the change record.

The owner login **cannot** take a logical backup: FORCE-RLS tables dump empty for it (**BC-12**, M0 G-11). The backup is always taken by the cluster superuser, or by the provider.

**Self-hosted, including the bundled database.** As the **cluster superuser** (PROVEN in R1):
```bash
pg_dumpall -U <cluster-superuser> --roles-only > roles.sql             # roles are cluster-wide: not in pg_dump
pg_dump    -U <cluster-superuser> -Fc --create -d <database> -f db.dump
```
- **Bundled database:** run both inside the container over the local socket (`$P $L exec -T rab-postgres …`, user `postgres`), then copy the files out.
- **Storage:** both files are secrets (`roles.sql` holds every role's password verifier). Keep them at `0600`, off the host, and encrypted. Check that both are non-empty before going on.

**Managed provider:** record the provider's **PITR timestamp** (`SELECT now()` on the database, plus the provider's restore window), or take a **snapshot**, and record its id.
- PITR retention must cover your incident-detection time (M0 §6.4).

**No backup or restore point means no transition, and no upgrade.** Since O3 the API applies pending migrations when it starts; nothing makes an apply reversible except this backup.

## 3. An old image on an upgraded database: NOT supported in production, fails closed

| Process (old code) | Production | Development |
|---|---|---|
| api | **Refused** by its own boot gate 7: `core.provision_workspace(uuid)` carries an `app_version` the old code does not know (`db:provision_workspace@WorkspaceGrantParityGuards1786721430000`). VERIFIED. | Starts, with warnings: ledger AHEAD by 4, unknown `provision_workspace` version. PROVEN. |
| worker | **Refused**, same gate. VERIFIED. | Starts, with the same warnings. PROVEN. |
| provisioner | **Refused** in every mode: the migration ledger is AHEAD of the code by 4. VERIFIED, and PROVEN in development (exit 1). | **Refused** (exit 1). PROVEN. |

**No data was damaged in R1.** Across the upgrade and the old-image runs, the data checksum (112 facts) changed only by:
- **the upgrade itself:** one `core.workspace_schema_migration` row;
- **the smoke runs:** one `core.audit_log` row each, from the scripted login attempt. That is the only write the old images made.

**The production verdict comes from the old code's gate function** (`old verdict … production=true: THROWS`). A real production boot of the old image in R1 stopped earlier, at its production configuration refusals: no S3 storage and an empty `TRUSTED_PROXY_CIDRS` on the disposable stack. So the full production boot path is NOT TESTED (section 6).

## 4. Rollback procedures

### 4.1 Self-hosted, from the pre-upgrade dump (PROVEN, R2)

Restore into a **fresh** cluster or volume. That is the proven path, and the **only** one that brings back the legacy logins' LOGIN attribute and password verifiers (BC-17): they come from `roles.sql`, which only a fresh cluster can take without conflicts. **A database-only `pg_restore` into the same cluster does not restore role attributes**: after it, `crewflow` and `crewflow_app` are still NOLOGIN and every legacy login still has PASSWORD NULL. In-place restore over the upgraded database is NOT TESTED.
1. Stop the owner-login stack: `docker compose … down`. **Never** use `-v` on a volume you may still need.
2. Start a fresh PostgreSQL 16 cluster: a new data directory, or a new volume.
3. **Restore the roles first**, skipping the fresh cluster's own superuser, which already exists:
   ```bash
   grep -v -E '^(CREATE|ALTER) ROLE <cluster-superuser>[ ;]' roles.sql > roles-restore.sql
   psql -X -v ON_ERROR_STOP=1 -U <cluster-superuser> -d postgres -f roles-restore.sql
   ```
   **Bundled database, NOT TESTED:** a fresh bundled volume runs the `crewflow_owner` init before you can restore. Exclude that role's `CREATE ROLE` line as well (keep its `ALTER ROLE`), or restore into a plain PG16 container without the init script.
4. **Restore the database:**
   ```bash
   pg_restore -U <cluster-superuser> --create -d postgres --exit-on-error db.dump
   ```
5. **Verify** before any traffic:
   - the migration ledger has the pre-upgrade row count (250 in R2), with no owner-login migration in it;
   - the deployment identity marker is the pre-upgrade one (if the deployment declared an id; it is optional, BC-11);
   - the legacy logins are LOGIN again **with** their password verifiers (the transition had made `crewflow` / `crewflow_app` NOLOGIN and set PASSWORD NULL on them and on `crewflow_worker`, BC-17), so the old URLs work unchanged. As the cluster superuser:
     ```sql
     SELECT rolname, rolcanlogin, rolpassword IS NOT NULL AS has_password
       FROM pg_authid WHERE rolname IN ('crewflow_app','crewflow','crewflow_worker','crewflow_migrator') ORDER BY rolname;
     ```
     Every row must show `rolcanlogin = t` **and** `has_password = t` (`crewflow_migrator` only if the deployment used it). If any row shows `f`, the roles were not restored from `roles.sql`: stop, and restore again into a fresh cluster.
6. **Deploy the previous image digest** with its previous configuration. That means the separated env files, which the transition kept untouched (`OWNER-LOGIN-DEPLOYMENT.md` §5.4).
7. **Check the old processes:** api, worker and provisioner start with no "ledger AHEAD" or unknown-`app_version` warning. Then run the functional smoke from `OWNER-LOGIN-DEPLOYMENT.md` §5.8 against the old stack.
8. **Accept the loss:** every write made after the dump is lost. Record it.

### 4.2 Managed provider, from PITR or a snapshot (text only, NOT TESTED)
1. **Restore as a NEW instance or database** at the recorded PITR timestamp, or from the snapshot. The roles come back with it; never restore over the live instance.
2. **Point the old image's legacy URLs at the new instance:** the separated `crewflow_app`, `crewflow` and migration logins, kept from before the transition. Use the new instance's **direct** host and its CA for verify-full.
   The restore point is from before the transition, so these logins come back as LOGIN with their passwords (BC-17 disabled them only after the transition). Check `rolcanlogin` and the password as in §4.1, step 5.
3. **If the host changed and the deployment declared an id, rebind the deployment identity** with the existing `db:bind-identity` command. Do this before the old processes start, because they refuse an identity mismatch. The old separated code may require the id even though the owner-login code treats it as optional (BC-11); follow its refusal message.
4. **Deploy the previous image digest** with its previous configuration. Check it as in 4.1, steps 5–7.
5. **Accept the loss and choose the point carefully:**
   - Writes made after the restore point are lost.
   - **Choose a point from before any incident.** A restore point taken after a compromise carries the attacker's roles, definers and policies with it (G-11, M0 §6.4). Under the owner login, rotating the password is not remediation.
   - Keep the upgraded instance, stopped and unreachable, for forensics until the owner releases it.

### 4.4 Image-only rollback from a one-image release (O2) to the two-image v0.4.0

O1/O2 changed only the image layout and the tag. One image now runs every application service, under ONE tag (the full
commit) and ONE compose variable, `CREWFLOW_IMAGE_TAG` (named `CREWFLOW_IMAGE_DIGEST` until 2026-11-11). Neither O1 nor O2 adds a migration. The last two-image
release is **v0.4.0** (git tag `rab/v0.4.0`, commit `e1b1132a075fd6b821562eaaf0921eeee8243617`, publish-image run
42030739036, both attested):

| Image | Tag | Index digest |
|---|---|---|
| API (also rab-migrate, rab-ops) | `api-e1b1132a075fd6b821562eaaf0921eeee8243617` | `sha256:1120f03a223be14fcd635bcd32734c34dd2aec3213084d47894b727af7c230fa` |
| Worker | `worker-e1b1132a075fd6b821562eaaf0921eeee8243617` | `sha256:bbe0e79adc8c5f84d1a8dee75c6403b1449ee9fc2d4a2fbcc33c5e93cafbaaf4` |

**When it applies.** Only when the database has no migration that v0.4.0 does not know, or only migrations that were
reviewed as expand-only (`OWNER-LOGIN-DEPLOYMENT.md` §3.6a). Otherwise this is not an image rollback: use the restore
paths in §4.1 / §4.2. Check this first, as the owner login, read-only. Compare the ledger with v0.4.0's migration list:
```sql
SELECT count(*), max(timestamp) FROM core.migrations;
```
If the count is larger than v0.4.0's, list the extra rows and confirm each was reviewed as expand-only.

**Procedure (NOT TESTED as a whole; each step uses v0.4.0's own committed files and checks):**
1. **Use v0.4.0's compose files, not the current ones.** The current `docker-compose.image.yml` reads only
   `CREWFLOW_IMAGE_TAG` and would start the API image as the Worker as well. Check out the release tag beside the
   current tree:
   ```bash
   git -C <repo> worktree add /opt/crewflow-v0.4.0 rab/v0.4.0     # or: git archive rab/v0.4.0 packages/rab-docker | tar -x
   ```
2. **Write a v0.4.0 compose env file.** Copy the current `compose.env`. Remove `CREWFLOW_IMAGE_TAG` and
   `CREWFLOW_IMAGE_REPOSITORY`, and set the two retired variables, which v0.4.0 reads:
   ```
   CREWFLOW_API_IMAGE_DIGEST=sha256:1120f03a223be14fcd635bcd32734c34dd2aec3213084d47894b727af7c230fa
   CREWFLOW_WORKER_IMAGE_DIGEST=sha256:bbe0e79adc8c5f84d1a8dee75c6403b1449ee9fc2d4a2fbcc33c5e93cafbaaf4
   ```
   Lint it with **v0.4.0's** linter. The current linter refuses these two names on purpose:
   `node /opt/crewflow-v0.4.0/packages/rab-docker/scripts/compose-owner-login.cjs --lint-env-file compose <file>`.
   The secret files (`database.env`, `runtime.env`) stay as they are: v0.4.0 already ran on the owner login. If a later
   release added runtime settings that v0.4.0 refuses, remove them from `runtime.env`, as its start-up refusal names them.
3. **Verify the deployed model with v0.4.0's verifier:**
   `node /opt/crewflow-v0.4.0/packages/rab-docker/staging/verify-image-compose.cjs --environment --env-file <file>`.
4. **Pull both digests and stop the current stack**: `docker compose … down`, **never** `-v`.
5. **Start v0.4.0:**
   `docker compose --env-file <file> -f /opt/crewflow-v0.4.0/packages/rab-docker/docker-compose.image.yml up -d --wait`.
   Add the same overlays the deployment uses, from the v0.4.0 tree. Its `rab-migrate` check must exit 0 (nothing
   pending), or warn about an AHEAD ledger for reviewed expand-only migrations only.
6. **Check:**
   - `docker inspect -f '{{.Config.Image}}'` shows the API digest on rab-api and the Worker digest on rab-worker;
   - both services are healthy;
   - there is no unknown-`app_version` or "ledger AHEAD" refusal;
   - run the functional smoke from `OWNER-LOGIN-DEPLOYMENT.md` §5.8.
7. **Return to the current release** later the usual way. Use the current tree's compose files and `compose.env` with
   `CREWFLOW_IMAGE_TAG`, and delete the v0.4.0 env file.

No data is restored or lost by this procedure; it changes only which images run.

### 4.3 After a rollback
- `crewflow_owner` may exist on the restored instance (managed PITR to a point after 5.3, or a later owner-login release). Have the admin run `ALTER ROLE crewflow_owner NOLOGIN` (reversible). **Never `DROP ROLE`** it without Agent 1's guidance.
- Re-attempt the upgrade only from section 2 again: a fresh backup or restore point, then the upgrade (`OWNER-LOGIN-DEPLOYMENT.md` section 3: stop-then-start; the API migrates on start).

## 5. Evidence (Agent 1, disposable PG16.15)

| Step | Result |
|---|---|
| **R1-1** Separated build with the OLD code (fresh migration-security scenario) | PASS |
| **R1-2** Seed with the OLD code: organisation, active user, workspace provisioned READY, 2 venues | PASS |
| **R1-3** Baseline: OLD api, worker and provisioner on the separated database | All healthy; the old gate verdicts pass in both modes |
| **R1-4** Backup before the upgrade, as the cluster superuser (`pg_dumpall --roles-only` + `pg_dump -Fc --create`) | PASS (1312 KB dump plus the roles file) |
| **R1-5** Upgrade: `transition-from-separated.sql`, then the owner-login migrate child (NEW code) | CHAIN-PARTIAL; 4 applied as `crewflow_owner` (`PreAuthTablesForceOwnerOnly1786721400000`, `WorkspaceRegistryGuardAllowList1786721410000`, `OwnerLoginGrantParityGuards1786721420000`, `WorkspaceGrantParityGuards1786721430000`); post-checks passed; exit 0 |
| **R1-6a** OLD image on the upgraded database, development | api and worker run with warnings; provisioner refused (exit 1); old verdicts: api and worker THROW in production, provisioner THROWS in both |
| **R1-6b** OLD image on the upgraded database, production | Stopped at the production config refusals (no S3, empty `TRUSTED_PROXY_CIDRS`); same old verdicts |
| **R1-7** Data risk | Checksum: only audit rows from the login attempts (plus the upgrade's one migration row) |
| **R2-1** Fresh cluster: roles restored (superuser skipped), then `pg_restore --create` | PASS |
| **R2-2** Restored data vs the pre-upgrade state | **CHECKSUM EQUAL (112 facts)**; ledger 250, no owner-login migration |
| **R2-3** OLD image on the restored database | api healthy, worker running, provisioner running; old gate verdicts pass in both modes; the boot gates report `pending=0 schema=compatible gates=ok` |

The logs are in the session scratchpad (`a1/rollback/r1b.log`, `r2.log`, `evidence-r1/`, `evidence-r2/`). They were not committed.

## 6. NOT TESTED
- **A real production boot of the old image.** It needs TLS, S3 and a bound identity marker. The production verdict above comes from the old code's own gate function, not a production process.
- **PostgreSQL 18:** the proof ran on 16.15 only.
- **PITR or snapshot restore on any managed provider** (section 4.2 is text only).
- **In-place restore over the upgraded database,** and the bundled-database restore detail (section 4.1, step 3).
- **A rollback after real traffic.** R1 and R2 used a seeded test organisation only.
