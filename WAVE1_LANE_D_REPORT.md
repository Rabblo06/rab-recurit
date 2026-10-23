# Wave 1, lane D: deployment definitions

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation` (HEAD `7a4ce4e3`). **Mode:** file edits only.
- Nothing was committed, pushed, deployed, built or started. There was no `docker compose up` and no image build.
- No production system, OpenShip, Neon, Render or DigitalOcean was contacted.
- No secret value was printed. Validation used `docker compose config` plus offline calls into the real launcher and
  runtime guard, with placeholder credentials.
- **Evidence:** `docs/evidence/wave1-lane-d/` (git-ignored, like all of `docs/`).

## 1. What changed

| File | Change |
|---|---|
| `packages/rab-docker/docker-compose.qa.yml` | Rewritten to mirror the intended production topology (section 2) |
| `render.yaml` | **Deleted** (section 3) |
| `packages/rab-docker/docker-compose.production.yml` | Verified. Edits: `HWS_RUNTIME_ENABLED: "false"` committed on `rab-api` and `rab-worker`; N1 described in the `rab-migrate` comment; header sections for the provisioning path and the release-content constraint; `WORKSPACE_BASE_DOMAIN` marked as an owner decision (section 4) |
| `packages/rab-docs/developers/deployment.mdx` (tracked) | Removed the stale `start.sh`-migrates and Render text. Now documents the three compose deployments, the explicit migrate job, the guards, Render retired, and the provisioning path |
| `docs/PRODUCTION_RELEASE_RUNBOOK_2026-10-22.md` (git-ignored) | Header update; new 0a (Release A vs B, topology), 1.3 (Render), corrected section 2 (the old patch recipe no longer builds on `origin/main`), 6a (per-service role cutover, names only), 7.8 (N1 approval procedure and table), 9.3 (deployment-definition rollback), R10, and 13 (owner decisions D1–D10) |

## 2. QA compose

**Before (two defects):**
- API and worker used `DATABASE_URL=crewflow` (the owner login), which `assertRuntimeDbRole` refuses
  (`assert-runtime-db-role.ts:21,43`), together with `DATABASE_URL_UNPOOLED: ''`.
- There was no `RAB_RUNTIME_ENV` and no `DATABASE_DIRECT_URL`. The worker was the plain jobs process with no
  provisioner, so new workspaces stayed CREATING. Migrate had no phase checks and no bootstrap passwords, so it could
  not create the roles. Hardcoded DB passwords sat on ports published on all interfaces.

**After:**
- **API:** `crewflow_app` only.
- **Worker:** the bundle, same recipe and security settings as production: jobs on `crewflow_app`, pooled and direct;
  provisioner child on `crewflow`, through `CREWFLOW_PROVISIONER_DATABASE_URL`.
- **Runtime services hold no** `DATABASE_URL_UNPOOLED`, `DB_TARGET`, `CREWFLOW_MIGRATION_*` or bootstrap credentials.
  `RAB_RUNTIME_ENV=development` is set: the strictest non-production mode, which refuses any non-local host.
- **Migrations:** only through the profile-gated `migrate` job. It refuses without approval and applies the production
  phase rules (A = `rab_owner`, B = not a runtime login).
- **Secrets:** come from git-ignored `packages/rab-docker/.env.qa.local` as required `:?` variables, so the file
  fails closed without them.
- **Ports and storage:** host ports are loopback only, with no Redis host port. S3 runs through MinIO with SSE header
  NONE, as on R2. There is no shared volume between API and worker. Healthchecks cover all long-running services.

**HWS decision: OFF in QA.** QA exists to test what production will run, and production keeps HWS off until G4. Dev
stays HWS-on.

**Differences from production that remain:**
- `NODE_ENV=production` is impossible off the Neon endpoint.
- Migrations run with `DB_TARGET=local`, which N1 does not restrict, so QA applies G1 and has server-path provisioning
  plus the reconciler.
- There is a local superuser.

## 3. render.yaml: deleted, not stubbed

Render's docs say "changes to a Blueprint never cause a resource to be deleted". So:
- deleting the file cannot delete or create a service;
- a stub that still names `rab-server`/`rab-worker` would make a linked Blueprint sync and **redeploy** the stale image.

Neither option turns off auto-deploy on a service that already exists.

**Assumption (unverifiable):** no Render service is still linked to this repository. The owner must check the
dashboard (runbook 1.3 and D8). No workflow calls a Render deploy hook.

Dangling `render.yaml` mentions remain, in comments only, in files owned by other lanes:
- `rab/Dockerfile:40,79`
- `rab/start.sh:28`
- `setup-db.ts:2`
- `health.controller.ts:4`
- `.github/workflows/cd-deploy-tag.yaml:4-5`
- `rab-workforce-architecture.md:344`

## 4. Production topology at the next release

Production **must keep the privileged reconciler**:
- G1 (`1786719500000`) is not on the N1 list, so `core.provision_workspace` will not exist. The API gets 42883 and
  returns `DEFERRED`.
- `createFor` workspaces need the reconciler regardless.
- G2 is unapproved.

**Release A** (`origin/main` 5968fc52, 186 migrations) cannot build the bundle (no `Dockerfile.worker-bundle`). It must
use the five-service compose, which was validated (log 08).

**Release B** (this branch) uses the committed bundle file. But N1 refuses the **whole** production run while any of 8
migrations is unapproved, and `1786719520000` needs SUPERUSER/BYPASSRLS. So Release B cannot migrate production today.

**Recommendation:** Release A, five-service, for the role cutover; then the bundle in a later release.

## 5. Validation (all in the evidence folder)

| Log | Result |
|---|---|
| 01 | QA config without secrets fails closed on all 9 required interpolations; with placeholders it passes |
| 02 | 64/64 QA invariants pass |
| 03 | The real launcher `makePlan` accepts the QA worker. The jobs child gets no provisioning URL and HWS=false; the provisioner child gets no `APP_SECRET` |
| 04 | The real runtime guard accepts api/jobs/provisioner as LOCAL and refuses the `UNPOOLED` negative control |
| 05, 06 | Production config passes, all invariants pass |
| 07 | The documented Release-B OpenShip env is accepted by the launcher and guard (PRODUCTION, `ep-round-rain-aess0njf`/`neondb`). 7 stale or misconfigured shapes are refused |
| 08 | Five-service file valid, buildable from `origin/main` |
| 09 | N1 list vs. migrations |

## 6. Owner decisions (runbook section 13)

| # | Decision |
|---|---|
| D1 | OpenShip vs DigitalOcean. Moving changes `EXPECTED_PRODUCTION_IDENTITY` and needs a new release |
| D2 | Release A vs B |
| D3 | N1 approval list, including `1786719520000` |
| D4 | G1-prod / G2 |
| D5 | `TRUSTED_PROXY_CIDRS` values |
| D6 | `WORKSPACE_BASE_DOMAIN`: recommended unset until the D-C1 fix ships |
| D7 | Whether to bind `rab-api` to loopback |
| D8 | The Render dashboard check |
| D9 | Re-enabling auto-deploy |
| D10 | Phase-B identity on Neon |

## 7. Findings for other lanes

- **Worker-bundle allowlist drift (Medium, lane A + the bundle owner).** Lane A's uncommitted env work adds:
  - `APP_JWT_LEGACY_VERIFY_ENABLED`
  - `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED`
  - `AUTH_LOGIN_*`
  - `AUTH_REVOKE_PASSWORD_SESSIONS_ON_DISABLE`

  `start-worker-bundle.cjs` `JOBS_ENV_KEYS` (lines 51-85) forwards none of them. If production sets them, the
  Worker's jobs process silently runs with defaults that differ from the API's. Example: with
  `APP_JWT_LEGACY_VERIFY_ENABLED=false`, the jobs process would still verify with the legacy key.
  - **Fix:** add the relevant keys in the same change that introduces them, and extend `launcher.test.cjs`.
- `docs/HANDOFF.md` and `THREAT-MODEL.md` were not edited, because they are outside this lane. The coordinator should
  record the `render.yaml` removal and the QA topology change.

## 8. Security trade-offs

- **QA MinIO credentials stay committed.** They are throwaway credentials, reachable only on loopback, and match the
  dev stack. Moving them to `.env.qa.local` would add friction for no isolation gain.
- **Production `rab-api` still publishes `3000:3000` on all interfaces** (R7, D7). This is unchanged, because loopback
  binding could break OpenShip's proxy path, which cannot be verified offline.
