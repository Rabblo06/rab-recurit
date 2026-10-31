# Screen traffic (Phase C1 polling measurement)

Measures what the clients' polling costs, per screen, on the disposable cost harness (`../README.md`; every harness
safety guard applies: `costaudit-*` containers, project `crewflow-cost`, loopback ports 25470/26470/29070/23070, the
disposable-database marker, no mount of the main checkout, the main-checkout drift guard). The same scripts produce
the "before" and the "after" numbers; only the **schedule file** (what each screen requests, and when) and the code
under test change.

## One command

```bash
cd /c/rab-ai-wt/c1      # a worktree, never C:/Rab-recruit
# before (main 614796f0; client code = m2, tree-identical for rab-front/rab-mobile/rab-iphone)
bash packages/rab-e2e-testing/cost/screen-traffic/run.sh --commit 614796f0 \
  --schedule packages/rab-e2e-testing/cost/screen-traffic/schedules/before-614796f0.mjs \
  --front /c/rab-ai-wt/m2/packages/rab-front --out /c/rab-ai-wt/cost-work/results/c1-before
# after (uncommitted C1 tree, or --commit <sha>): write schedules/after-<x>.mjs with the SAME screen ids, then
bash packages/rab-e2e-testing/cost/screen-traffic/run.sh --tree /c/rab-ai-wt/c1 \
  --schedule packages/rab-e2e-testing/cost/screen-traffic/schedules/after-<x>.mjs \
  --front /c/rab-ai-wt/c1/packages/rab-front --out /c/rab-ai-wt/cost-work/results/c1-after
# pre-built images instead of a build (e.g. the C1 run): docker tag rab-server:<x> crewflow-cost/server:<tag> (same for
# worker), then --image-tag <tag> in place of --commit/--tree. The C1 after run used --image-tag c1-after.
# compare: node packages/rab-e2e-testing/cost/screen-traffic/compare.mjs <before dir> <after dir>  -> <after>/COMPARISON.md
# Flutter emulator (optional, after the server/web phases, stack kept with --keep):
bash packages/rab-e2e-testing/cost/screen-traffic/flutter/measure-flutter.sh --src-commit 614796f0 \
  --out /c/rab-ai-wt/cost-work/results/c1-before/flutter
```

Keep `--window-s`, `--hidden-window-s`, `--solo-window-s`, `--warmup-s`, the mix and `COST_SEED_*` identical between
the two runs, run them back to back, and compare `host-conditions.log` first (free RAM, heavy-run token owners, other
containers' CPU), exactly as the harness README's "Comparability on a shared host" says.

Phases (`--only stack,seed,server,web,down`): `stack` (images, fresh stack, harness seed 20 orgs, uploads), `seed`
(`seed-screen-traffic.sh`: venue requests + one platform admin), `server` (load windows), `web` (Playwright), `down`.
`--keep` leaves the stack up for the emulator step.

## What is measured

| Part | How | Label |
|---|---|---|
| Server load under polling | `run-load.mjs` replays every user's screen schedule against the API (Node fetch, keep-alive) while the harness's `measure.sh idle` window records `pg_stat_statements`, cgroup CPU of pg/api/worker/redis/minio, docker stats memory, Redis ops and host contention. Windows: `mix-visible`, `mix-hidden` and one `solo-<screen>` per screen. | MEASURED |
| Per-request SQL | The API's own `request_complete` log (`sqlCount`, `durationMs`) joined by `x-request-id` (`lib/api-sql.mjs`). | MEASURED |
| Requests, bytes, 429, overlap | Every request the generator sends (`requests-<label>.jsonl`): status, response body + header bytes, client latency, timer overlaps / ticks skipped while in flight / deduplicated joins. | MEASURED |
| Per user / per hour | Window totals ÷ users, × 60. | DERIVED |
| iOS screens | Schedule read from the Swift code (no macOS here); the server cost of that schedule is measured. | schedule DERIVED, cost MEASURED |
| Real web client | `web/measure-web.mjs`: the real rab-front, served by Vite on 127.0.0.1:23173 with `/rest` proxied to the harness API only, driven by headless Chromium; requests and bytes per screen while visible, hidden (emulated), visible again. | MEASURED (hidden = emulated visibility) |
| Real Flutter client | `flutter/measure-flutter.sh`: debug APK on the `Pixel_5` emulator, counted from the API log per window (foreground / Home pressed / foreground) + `dumpsys netstats` bytes for the app uid. | MEASURED |

Shared IP: users with the same `ip` in the mix send the same `cf-connecting-ip` (the API trusts it only from the harness
network), so they share the global throttler's 120 req/min/IP, exactly as phones on one venue Wi-Fi or carrier NAT do.
Rate limits stay ON (the harness never disables them).

## Schedule format (`schedules/*.mjs`)

`export default { name, screens: { '<screen id>': Screen } }`. Screen ids are the contract between before and after.

- `client` (`flutter`/`ios`/`web`), `auth` (`mobile` = Bearer, `web` = session cookie + Origin), `basis` (`CODE`/`DERIVED`).
- `backgroundHeader`: `never` | `always` | `after-idle-60s` (rab-front: no input for 60 s) — whether
  `X-Crewflow-Background: 1` is sent; a timer may override it.
- `onStart`, `onResume` (run when the app/tab becomes visible again): step lists.
- `timers[]`: `{ name, intervalMs, jitterPct (0.2 = ±20 %), firstAfterMs, policy, whenHidden: 'run'|'skip', backgroundHeader, backoff, steps }`.
  - `policy`: `fixed-allow-overlap` (Dart `Timer.periodic`: ticks never wait), `fixed-skip-if-inflight` (TanStack
    `refetchInterval`: a tick while the query is in flight is dropped), `serial-sleep-then-run` (Swift Task loops and any
    single-flight scheduler: sleep, run to completion, sleep).
  - `backoff: { defaultRetryAfterS: 30, capMs: 300000 }`: after a 429 wait `Retry-After` (else the default); after other
    errors `intervalMs × 2^failures` up to `capMs`; reset on success. Implies the serial loop.
- Steps: `{ get, capture?, dedupe? }`, `{ post, body }`, `{ pageAll, limit }` (page=N&limit=L until `total`, as Flutter
  and iOS `all()`), `{ parallel: [...], onError: 'wait-all'|'cancel-others' }`, `{ seq }`, `{ ifCap: '<flag>', from:
  'caps', steps, swallow }`, `{ swallowAll: [...] }` (errors ignored, as the client does), `{ derive: '<name>' }` (named
  response-dependent sequences in `lib/engine.mjs`, e.g. the pipeline's avatar previews). `dedupe: '<key>'` joins a
  request already in flight for the same user (Flutter `_loading`, TanStack shared query keys).
  Placeholders: `{pipelineShiftId}` (resolved per user from the seed, `lib/harness.mjs`), `{adminQueue}`.

## Files

`run.sh` (orchestration), `run-load.mjs` + `lib/engine.mjs` (load generator), `lib/harness.mjs` (guards: harness API
port owner, disposable-DB marker, seed password from `$COST_SECRETS`, never printed), `lib/api-sql.mjs`,
`analyze.mjs` (per window: `analysis-<label>.{json,md}`), `report.mjs` (`results.{md,json}`), `compare.mjs` (before/after), `seed-screen-traffic.sh`,
`mixes/c1-mix.mjs` (the measured user mix), `mixes/smoke.mjs` (one user per screen, functional check), `web/`,
`flutter/`, `schedules/`.

## Harness changes made for 614796f0 (Phase B config)

`docker-compose.cost.yml`: one `PG_DATABASE_URL` per process on the compose service name `pg` (a listed local database
service host), no `DB_TARGET` in the runtime environment (the API/Worker refuse it; migrate/tool set it),
`PG_POOL_MAX_CONNECTIONS=12` for the worker, `CORS_ORIGINS` overridable (`COST_CORS_ORIGINS`; screen-traffic adds the
Vite origin). `lib/common.sh`, `scripts/stack.sh`, `scripts/check-isolation.sh` follow the host change. This copy of the
harness therefore targets 614796f0 and later; commits before Phase B need the p6-agents copy.
