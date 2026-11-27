# M9 restore drill (InstaBox ibox2, 2026-11-21)

Lane F hardening evidence. A rehearsal of `docs/release/MIGRATION-AND-ROLLBACK-PLAN.md` §5 on a disposable host: back up
a seeded, production-shaped database, restore it into a fresh cluster, prove the security posture survived, and run the
application on the copy. Script: `packages/rab-e2e-testing/system/perf/stack/restore-drill.sh`. Never production, never a
shared database: every resource was a `crewtest-lanef-*` container or directory on ibox2, removed afterwards by name.

## Results at a glance

| | Result |
| --- | --- |
| Logical backup (`pg_dump -Fc` + `pg_dumpall --roles-only --no-role-passwords`) | 4.3 s for a 437 MiB database, 65 MB archive |
| Physical backup (`pg_basebackup -Ft -z -X stream`) | 7.1 s, 145 MB (taken for the timing; not restored, the host's disk was nearly full) |
| Data restored into a fresh cluster and counted | 9.6 s after the restore started (cluster 1.6 s, `pg_restore -j 2` 5.9 s) |
| Row counts and migration ledger vs the source at backup time | identical (19 tables, ledger 266 / 1786722700000, gated 1786721330000 absent) |
| FORCE-RLS coverage (`check-rls-coverage.ts` as `crewflow_owner`) | pass |
| Security-posture golden | pass |
| Semantic-posture golden | **FAIL on `main`** (role order of one policy, below); pass with the proposed one-line fix |
| Production-mode API on the copy | **refuses to start on `main`** (semantic-posture boot gate); with the fix: healthy in 2.1 s, console login and five console reads 200, staff-app login and history 200 |
| **RTO measured** (restore start to verified, serving real requests) | **15.6 s with the fix; not reachable on `main`** (the API never starts on a restored database) |
| **RPO** | **Up to the age of the last dump.** No backup automation exists in the repository (§3), so today it is the time since an operator last ran `pg_dump`; with the §5.1 daily timer it would be up to 24 h; WAL archiving (seconds to minutes) is not configured anywhere |

### The restore blocker (finding)

`check-semantic-posture` on the copy:

```
semantic posture DRIFT: [core]
 - policy|worker_dispatch_pointer|worker_dispatch_pointer_runtime_deny|RESTRICTIVE|crewflow,crewflow_app,crewflow_worker|*|...
 + policy|worker_dispatch_pointer|worker_dispatch_pointer_runtime_deny|RESTRICTIVE|crewflow_worker,crewflow,crewflow_app|*|...
```

and the API on the copy: `Database boot gate "semantic-posture" refused: the api process refuses to start: the database's
security objects differ from the reviewed posture ...`.

Nothing in the database differs: the same policy, the same three roles. The posture renderer lists a policy's roles with
`string_agg(<role name>, ',' ORDER BY 1)` (`packages/rab-server/src/database/posture-drift/semantic-posture.ts:61`).
Inside an aggregate, `ORDER BY 1` orders by the constant `1`, not by the first column, so the names come out in the order
of the `pg_policy.polroles` array: the policy's `TO` list as it was stored, which `pg_dump` re-emits in its own order
(not strictly role OID order). After a restore the array order of this policy differs, the line differs, and the
fail-closed boot gate refuses. Every restore onto a new cluster hits this; so would any
migration of the database to another provider.

Proposed fix (not committed: `semantic-posture.ts` is in another lane's open PR #253), applied on the test host for
run B:

```diff
-         || '|' || coalesce((SELECT pg_catalog.string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(x)::text END, ',' ORDER BY 1)
-                             FROM pg_catalog.unnest(p.polroles) x), '')
+         || '|' || coalesce((SELECT pg_catalog.string_agg(pr.r, ',' ORDER BY pr.r COLLATE "C") FROM (SELECT CASE WHEN x = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(x)::text END AS r
+                             FROM pg_catalog.unnest(p.polroles) x) pr), '')
```

The committed goldens already list these roles alphabetically, so they do not change. The same `ORDER BY 1` pattern is in
`workspace-schema-fingerprint.ts:97` (workspace policies) and `database/boot-checks/owner-login-posture.ts:417`
(pre-auth definer policies); both want the same fix. Regression test: create a policy for three roles created in
non-alphabetical order and assert the rendered line lists them alphabetically (unit, real PostgreSQL), plus a restore
round-trip in CI (`pg_dump` → fresh cluster → `check-semantic-posture`).

```
[MEDIUM] (availability / recovery)
Failure:      operator → restores the documented backup onto a new cluster (disaster recovery, provider move) → the
              API and the Worker refuse to start (semantic-posture boot gate), so the restore does not bring the service back
Actor:        none (a defect, not an attack)
Location:     packages/rab-server/src/database/posture-drift/semantic-posture.ts:61
Root cause:   aggregate `ORDER BY 1` sorts by a constant; the rendered role list follows the polroles array order, which a
              dump and restore can change
Fix:          sort by the role name (diff above), in the posture renderer and the two other renderers with the same pattern
Regression:   renderer test with roles created out of order; CI restore round-trip
```

## 1. Source

The database the M9 load test ran against (`LOAD-TEST.md`), after the measured runs, so it holds real traffic as well as
the seed: PostgreSQL 16.16, TLS, owner-login install (266 migrations including the draft index migration of #312),
`crewflow_owner` NOSUPERUSER NOBYPASSRLS, FORCE RLS, six workspaces. 437 MiB. Row counts at backup time (identical on
the copy):

| Table | Rows | Table | Rows |
| --- | --- | --- | --- |
| user | 5,018 | attendance | 91,426 |
| staff_profile | 5,009 | payroll_record | 89,776 |
| shift | 73,222 | payroll_run / lines | 1 / 6,886 |
| shift_assignment | 127,189 | audit_log | 119,569 |
| job_offer | 127,187 | user_session | 31,914 |
| shift_report | 49,989 | email_outbox | 265 |
| venue / job_role | 21 / 1 | organisation / workspace | 6 / 6 |

## 2. Steps and timings (run B, 2026-11-21 19:15 UTC)

| Step (§5.2 of the plan) | What ran | Time |
| --- | --- | --- |
| Stop the application | API, Worker and sinks stopped and gone (the Worker drains for up to 30 s); 0 `crewflow_owner` sessions left | before the clock |
| Back up | `pg_dump -Fc` and `pg_dumpall --roles-only --no-role-passwords`, superuser over the local socket inside the source container; SHA-256 recorded | 4.3 s |
| (physical) | `pg_basebackup -Ft -z -X stream -c fast` (needed a `local replication` pg_hba line the bundled db does not have) | 7.1 s |
| **RTO clock starts** | | 0 |
| 1. Fresh cluster, same minor | `postgres:16` (16.16) container, scram, data checksums, then TLS as on the source | 1.6 s |
| 2. Verify, roles, new password | checksums; roles file (one expected error: the bootstrap superuser already exists); `crewflow_owner` given a NEW random password (the copy never reuses the source credential) | 0.3 s |
| 3. Restore | `pg_restore --exit-on-error -j 2` as the superuser, owners and ACLs kept (never `--no-owner`); 4,147 TOC entries | 5.9 s |
| 4. Database-level grants | re-applied from the source catalog: a `-Fc` archive of one database carries neither its `GRANT ... ON DATABASE` nor its `ALTER DATABASE ... SET` (none were set) | 0.1 s |
| 5. Verify | `ANALYZE`; row counts and ledger equal; deployment identity (unbound on this throwaway source, so no rebind); `check-rls-coverage.ts` as `crewflow_owner`; security and semantic posture goldens | 1.6 s + 1.4 s |
| 6. Serve | production-mode API on the copy (same build), `/healthz`, console login + 5 reads, staff-app login + history | 2.1 s + 1.0 s |
| **RTO clock stops** | | **15.6 s** |

Run A (the same steps on `main` as is) stopped at step 5: semantic-posture DRIFT, and the API refused to start
(gave up after 180 s).

`/healthz` on the copy reported `upgradeFailed: true`. That flag was already on the source: the fixture seed's
workspaces made the migrate child's workspace adoption step return 70 (`AHEAD outside a step`) on the test host. It is a
property of the synthetic data, carried faithfully by the restore, not of the restore.

## 3. Compared with MIGRATION-AND-ROLLBACK-PLAN.md §5

| Plan says | Drill | Gap / action |
| --- | --- | --- |
| §5.1 pre-release and daily `pg_dump -Fc`, roles without passwords, `age`-encrypted to an offline key, SHA-256, uploaded to another provider with object lock | dump, roles file and SHA-256 done; **no encryption** (`age` is not installed on the test host and nothing could be installed: its root disk was full), no upload | Time `age -r` / `age -d` on the target host (streaming, I/O bound). The daily timer and the upload are not in the repository: someone has to own them before go-live |
| §5.1 physical base backup + WAL archive "(self-hosted) the Infrastructure agent's `hosting/backup/pg-backup.sh`" | `pg_basebackup` works once pg_hba allows replication | **`hosting/backup/pg-backup.sh` does not exist in the repository; no `archive_command` is configured anywhere** (the bundled `db` service has none). Without WAL archiving the RPO is the dump interval |
| §5.2.1 disposable PostgreSQL 16 of the same minor; load the roles file; new random passwords | done (16.16) | The plan's `-v` password step must go through a script or stdin: `psql -c` does not interpolate `:'pw'` (the drill's first attempt left `crewflow_owner` without a password and the API failed with 28P01) |
| §5.2.2 verify checksum, `pg_restore -l`, then `pg_restore --exit-on-error`, never `--no-owner` | done | add: re-apply `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE` for `crewflow_owner` (not in a single-database `-Fc` archive); `pg_dumpall --globals-only` would carry it |
| §5.2.3 ledger, gated migration absent, deployment identity, ledger inventory, posture golden, `check-rls-coverage.ts` as `crewflow_app`, row counts | done, except the generated ledger inventory (L1) | `check-rls-coverage.ts` now runs as `crewflow_owner` (owner-login architecture); the plan still says `crewflow_app`. **Add the semantic-posture golden: it is what the API's boot gate checks, and it is the check that fails** |
| §5.2.4 the copy refuses every process until rebound as a throwaway | not exercised (source identity unbound) | rehearse with a bound source next time |
| §5.2.5 record RTO and RPO, destroy the copy | recorded here; destroyed (containers and directories removed by name) | |

## 4. RTO and RPO for production (estimate, stated so it can be challenged)

- **Data part, measured:** about 15 s for 0.4 GiB on 2 database CPUs; `pg_restore` scales roughly with size, about
  13 s per GiB here, so a 10 GiB database would take a few minutes.
- **What the drill did not include:** getting a host (minutes if one is ready, much longer if a VM must be built),
  fetching and decrypting the archive (seconds to minutes for a dump this size), DNS / tunnel switch-over, and the people
  steps (deciding to restore, rebinding the deployment identity as in §5.2.4). A realistic target is **RTO under 1 hour**
  with a pre-built host and a written runbook; it is **unbounded today** until the semantic-posture fix lands.
- **RPO:** the age of the newest dump. Proposal for the owner: a daily dump (24 h) plus the pre-release dump as the
  minimum; WAL archiving to the off-site bucket (RPO of minutes) before real payroll data is stored.

## 5. Reproduce

`bash packages/rab-e2e-testing/system/perf/stack/restore-drill.sh` on the load-test host (`RESTORE_LABEL=<name>` keeps
runs apart). It reads `env.sh` / `prodenv.sh` from the same directory and writes `results/restore-<name>/` (steps,
counts, check outputs, `timings.json`).
