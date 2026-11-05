# OpenShip compatibility of the image Compose variant

> **Owner login (2026-11-04).** The root Worker launcher is retired. OpenShip stays **unsupported** for the owner-login deployment (M0 D11); see `OWNER-LOGIN-DEPLOYMENT.md` section 6 and `OWNER-LOGIN-ORACLE-VM-PLAN.md`.
>
> **O1 (one image, 2026-11-05).** The API and the Worker are one image whose default user is the non-root `node` (1000), so a platform that drops `user:` no longer runs the Worker as root. The other dropped keys (read-only root, capabilities, no-new-privileges, PID limits, tmpfs, init) still make OpenShip unsupported. The rows below describe the earlier two-image, launcher-based deployment.

Status: analysis from public source, 2026-11-03. Owner decision R5: verify every H6 restriction against OpenShip and
never drop a security setting silently. Nothing was deployed, imported or connected.

## 1. What was checked, and the gap

| Item | Value |
|---|---|
| Source | `github.com/oblien/openship` (Apache-2.0), read-only clone |
| Latest release | **v0.9.8**, tag commit `7865dd18c77915a509014216e71afa8399a0523e`, published 2026-11-02 09:57 UTC |
| HEAD of `main` | **`1d0cb17d86c65595d14e891c5ad777276b816c32`**, 2026-11-03 15:09 UTC (22 commits after v0.9.8) |
| Difference between the two in the files cited below | Only `packages/platform/src/engine/modules/deployments/compose/deploy.service.ts` changed (+16/−7). The compose parser, the container runtime, the resource limits, the stability watch, the interpolation and the import path are byte-identical. Line numbers below are the same in both unless two are given (v0.9.8 / HEAD). |
| **Deployed OpenShip version** | **BLOCKED.** The OpenShip connector is not authenticated in this session, so the version running the temporary deployment is unknown. To unblock: the owner authorises the connector or states the version; then repeat this check at that tag (`git diff <tag> v0.9.8 -- <the files cited below>`). |

## 2. How OpenShip runs a Compose file

OpenShip does **not** run `docker compose`. It parses the file itself
(`packages/platform/src/engine/lib/compose-parser.ts`) and creates every service container through the Docker Engine
API with its own `HostConfig` (`packages/adapters/src/runtime/docker.ts:6475-6521`, `createContainer`). A Compose key
that the parser does not translate never reaches Docker.

That `HostConfig` sets only `RestartPolicy`, `LogConfig`, the resource limits, GPU and shared-memory options,
`PortBindings`, `Binds`, `NetworkMode`, `ExtraHosts` and `PidMode` (`docker.ts:6499-6521`). It sets no `User`,
`ReadonlyRootfs`, `Tmpfs`, `CapDrop`, `CapAdd`, `SecurityOpt` or `PidsLimit`. OpenShip applies exactly those
hardening flags to its **own** helper container in the Swarm runtime (`packages/adapters/src/runtime/swarm/runtime.ts:710-714`),
never to a user's services.

Unmodelled keys are collected as "unsupported" (`compose-parser.ts:683-730` `UNSUPPORTED_SERVICE_KEYS`, `756-818`
`collectUnsupported`) and shown in the import wizard (`prepare.service.ts:1284-1287`). Only **blocking** entries refuse
the import (`prepare.service.ts:1310-1316`, `ComposeConfigurationError`). Every other entry is a warning, and the
service deploys without the key.

## 3. Key-by-key matrix (`docker-compose.image.yml`)

Legend: **HONOURED** = applied to the container; **DROPPED (warning)** = imported without the key, the wizard lists
it; **DROPPED (silent)** = imported without the key and not listed; **REJECTED** = the import is refused. The same
result holds at v0.9.8 and HEAD for every row.

| Key | Services | OpenShip result | Evidence (file:line) | Consequence |
|---|---|---|---|---|
| `image` (`repository@sha256:…`) | all | HONOURED | `compose-parser.ts:195-209` (interpolated); `docker.ts:6385-6409` (pulled before the old container is removed; a digest reference is re-inspected) | The digest is what runs. |
| `command` (argv) | all | HONOURED | `compose-parser.ts:518`, `adapters/src/runtime/compose-cmd.ts:11-17` | — |
| `entrypoint` | rab-ops | HONOURED | `compose-parser.ts:604`, `compose-cmd.ts:31-35` | — |
| `environment`, `${VAR:?}`, `${VAR:-default}` | all | HONOURED; a missing required variable is listed for the operator to fill, not refused | `compose-parser.ts:405-430`, `packages/core/src/compose-interpolation.ts:341-370`, `prepare.service.ts:1280-1283` | An empty digest would be prompted for, not rejected. |
| YAML anchors / merge keys | — (not used) | HONOURED | `compose-parser.ts:167-171` | — |
| `ports` with a host IP | rab-api | HONOURED (an unpinned port defaults to loopback) | `docker.ts:666-705` | `${CREWFLOW_API_BIND}` is applied. |
| `volumes`: named volume, read-only bind | rab-redis | HONOURED | `compose-parser.ts:495-509` | — |
| `volumes`: `type: tmpfs` (long form) | rab-migrate | **REJECTED** (blocking) | `packages/core/src/compose-spec.ts:240-255`; enforced at `prepare.service.ts:1310-1316` and `modules/migration/migrate.service.ts:109` | **The variant cannot be imported** (§4). |
| `healthcheck` | rab-redis, rab-api, rab-worker | HONOURED | `compose-parser.ts:569-570`, `docker.ts:805-835`, `6377`, `6496` | — |
| `restart` (incl. `"no"`) | all | HONOURED | `compose-parser.ts:250-253`, `docker.ts:281-286`, `527-532` | — |
| `stop_grace_period` | rab-api, rab-worker | HONOURED (`StopTimeout`, whole seconds) | `compose-parser.ts:615-640`, `docker.ts:838-860`, `6378` | The 35 s / 55 s drains are kept. |
| `mem_limit`, `cpus` | rab-redis, rab-api, rab-worker | HONOURED (`Memory`, `NanoCpus`) | `compose-parser.ts:572`, `877-900`; `adapters/src/runtime/resource-limits.ts:29-48`; `docker.ts:6502` | — |
| `depends_on` with `condition:` | rab-api, rab-worker | **PARTIAL**: names only; `service_healthy` and `service_completed_successfully` are discarded without a warning; a dependency only has to be *running* | `compose-parser.ts:399-403` (`parseDependsOn` keeps the keys), `deploy.service.ts:290-306` / `293-309` ("Every service that must be RUNNING before this one is created"), `2732` / `2740` (a dependency that failed blocks its dependents) | rab-api could start while rab-migrate is still running. The application gates still hold: `api-prestart.sh` refuses pending migrations and the Worker refuses them too. |
| `env_file` | rab-migrate, rab-ops | **DROPPED (silent)**: not parsed and not in the unsupported list | `compose-parser.ts` (no `env_file` handling; table at `683-730` does not list it) | rab-migrate would start without its credential and refuse (no `PG_DATABASE_URL`): fail closed, but not reported at import. |
| `profiles` | rab-ops | DROPPED (warning): "every service in the file is imported" | `compose-parser.ts:729` | rab-ops would be started (prints `--help`, exits 0, restart "no"). |
| `user` | rab-api, rab-worker, rab-migrate | **DROPPED (warning)** | `compose-parser.ts:708`; no `User` at `docker.ts:6475-6521` | API: the image's `USER node` (1000) still applies. **Worker: the image's `USER root`** (`rab/Dockerfile.worker-bundle:103`) applies, which is what the launcher expects. |
| `read_only` | rab-api, rab-worker, rab-migrate, rab-ops | **DROPPED (warning)** | `compose-parser.ts:715` | Writable root filesystem. |
| `tmpfs` (service key) | rab-worker, rab-ops | **DROPPED (warning)** | `compose-parser.ts:716` | No per-child tmpfs. The launcher's preflight needs its directories; the Worker would fail or run without the isolation. |
| `cap_drop` | rab-api, rab-worker, rab-migrate, rab-ops | **DROPPED (warning)** | `compose-parser.ts:687` | Docker's default capability set (14 capabilities, including CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, NET_RAW). |
| `cap_add` | rab-worker | DROPPED (warning) | `compose-parser.ts:686` | No effect on its own, because the defaults already include SETUID/SETGID/KILL. |
| `security_opt: no-new-privileges` | rab-api, rab-worker, rab-migrate, rab-ops | **DROPPED (warning)** | `compose-parser.ts:690` | `NoNewPrivs=0`. |
| `pids_limit` | rab-api, rab-worker | **DROPPED (warning)** | `compose-parser.ts:699` | No PID/thread cap. |
| `name` (top level) | — | Not used; OpenShip names its own projects | — | — |

**Summary.** At v0.9.8 and HEAD, OpenShip drops **seven of the H6 runtime security keys** (`user`, `read_only`, `tmpfs`,
`cap_drop`, `cap_add`, `security_opt`, `pids_limit`) with an import warning, drops the `depends_on` conditions and
`env_file` silently, and honours the image digest, command, healthchecks, restart policies, grace periods and
memory/CPU limits. No OpenShip setting or feature applies the dropped keys to a user's service (option (c) below).

## 4. How the variant behaves on OpenShip

1. **Import refused.** rab-migrate's `/tmp` is a long-form `type: tmpfs` volume. OpenShip classifies that as blocking
   ("would be created as a persistent volume on disk rather than in memory") and refuses the whole file with
   `ComposeConfigurationError`. This is deliberate: the file cannot be deployed there with its security keys silently
   dropped.
   - Not verified from source: whether a redeploy of a project that was already imported repeats this check. The
     check runs on the prepare/import path and the server-migration path (`prepare.service.ts:1310`,
     `migrate.service.ts:109`).
2. **Runtime refusal (fail closed), if the import guard were removed or OpenShip started modelling long-form tmpfs.**
   rab-api and rab-worker run with `CREWFLOW_RUNTIME_ISOLATION=enforce`:
   - API: `CapBnd` would not be 0, `NoNewPrivs=0`, a writable root and no PID limit. `api-prestart.sh` refuses to
     start (exit 64) and names each gap.
   - Worker: `CapBnd` would be Docker's default set instead of `00000000000000e0`, `NoNewPrivs=0`, a writable root,
     0 of 4 tmpfs mounts and no PID limit. The launcher refuses with a `BundleConfigError`.

   **Dependency:** this needs release images containing the H6 enforce mode (commit 09286aef, in this branch's base). An image built
   before it ignores the variable and starts with a WARNING line, which is the current production file's behaviour
   ("warn").
3. **The production file (`docker-compose.production.yml`, build-based, default "warn") on OpenShip.** The same seven
   keys are dropped with warnings. The API and Worker start, and log one WARNING line naming each missing control.
   That is the documented H6 posture for the temporary deployment: it is reported, not refused. It is not changed
   here.

## 5. Options when a platform drops a security key

| Option | What it means | Assessment |
|---|---|---|
| (a) Enforce mode | `CREWFLOW_RUNTIME_ISOLATION=enforce`: the API and Worker refuse to start when any declared control is missing. | **The safe default; always on in this variant.** It turns a silent weakening into an outage that cannot be missed. It is not a deployment method: on OpenShip, nothing would run. |
| (b) Plain `docker compose` on a VM | Run `docker-compose.image.yml` with the Docker Compose CLI on a VM the operator controls. Compose applies every key. | **Recommended for staging and for the DigitalOcean production.** It matches the Infrastructure agent's topology A (one VM, self-hosted PostgreSQL 16, Redis, Caddy edge). Use a VM that OpenShip does not manage. Running a second, unmanaged stack on OpenShip's Oracle VM would compete with OpenShip's edge proxy for ports 80/443, and OpenShip does not know about the stack. |
| (c) An OpenShip feature or setting | A supported way to pass these keys. | **Not available** at v0.9.8 or HEAD. The keys are explicitly "not modeled", and the runtime has no per-service security settings. It would need an upstream change: the parser would have to map the keys and `docker.ts` would have to send them in `HostConfig`. |
| (d) Import guard | A long-form `type: tmpfs` mount, which OpenShip classifies as blocking. | **Included** (rab-migrate `/tmp`). It refuses the import before anything runs. It depends on OpenShip's current classification, which is why (a) stays as the runtime backstop. |

**Recommendation: (b) plain `docker compose` on a dedicated VM**, with (a) and (d) kept as safeguards. Do not deploy
this variant through OpenShip. The temporary OpenShip deployment stays as it is: not redeployed, not migrated, and
no settings changed (R4).

## 5a. PDF rendering after P5 (PDF renderer migration)

Since P5 the Worker image contains no browser: PDFs are rendered by the native renderer (pure JavaScript, vendored
fonts) inside the jobs process. For OpenShip this removes every **PDF-specific** concern:

- no Chromium process tree, so `pids_limit` (DROPPED above) no longer has to budget for browser threads, and no browser
  process can outlive a job;
- no browser sandbox, seccomp profile, user namespace, `/dev/shm` sizing or setuid helper is needed, so there is no
  security key a platform could drop that weakens PDF rendering in particular;
- no system fonts, fontconfig cache or `CHROMIUM_*` / `PLAYWRIGHT_*` settings to carry over.

This does **not** make the variant deployable on OpenShip. Every row of the matrix in §3 and the behaviour in §4 are
unchanged: `user`, `read_only`, `tmpfs`, `cap_drop`, `security_opt` and `pids_limit` are still dropped, and in enforce
mode the API and the Worker still refuse to start without them. P5 removes Chromium from that list of problems; it does
not remove the list.

## 6. Re-checking a newer OpenShip

```bash
git clone --filter=blob:none https://github.com/oblien/openship.git && cd openship
git diff v0.9.8 <new-tag> -- packages/platform/src/engine/lib/compose-parser.ts packages/core/src/compose-spec.ts \
  packages/adapters/src/runtime/docker.ts packages/adapters/src/runtime/resource-limits.ts \
  packages/platform/src/engine/modules/deployments/prepare.service.ts \
  packages/platform/src/engine/modules/deployments/compose/deploy.service.ts
grep -n "UNSUPPORTED_SERVICE_KEYS" -A 50 packages/platform/src/engine/lib/compose-parser.ts
```

If `user`, `read_only`, `tmpfs`, `cap_drop`, `cap_add`, `security_opt` or `pids_limit` leaves the unsupported table, check
that `docker.ts` really sends the matching `HostConfig` field before relying on it. Repeat the runtime proof: the API's
and the launcher's "runtime isolation as declared" line must appear.
