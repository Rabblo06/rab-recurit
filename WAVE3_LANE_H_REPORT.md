# Wave 3, Lane H: workspace subdomain routing (server + web)

Branch `feat/twenty-parity-foundation`. Nothing committed, pushed or deployed. Tests ran only on the shared disposable
`crewflow-test-db` (127.0.0.1:15436) with its Redis (16391). No migration written (lane S2 owns `HostLabelNamespace1786719820000`).
Evidence: `docs/evidence/wave3-lane-h/`. Threat model: `THREAT-MODEL.md` "Wave 3 Lane H" (H1–H5).

Goal (owner): `manager-a.<base>` resolves to Workspace A; one workspace per manager (no picker); the hostname is routing
context, never authorisation; every guard / service check / RLS layer is unchanged.

## 1. Design and trust model

| Question | Answer |
|---|---|
| Where does the host come from? | `Host`; `X-Forwarded-Host` **only** from a `TRUSTED_PROXY_CIDRS` peer (multi-valued → refused); otherwise the browser `Origin` (fixed API host topology). Never a query/body field. |
| How is it parsed? | `@rab/shared` `parseHostAuthority` / `classifyWorkspaceHost`: lower-case ASCII DNS only, no userinfo/path/comma/IPv6/raw IDN/trailing dot, exact base-domain port, exactly one label, reserved list + prefixes (`..--`/`xn--`, `api-`, `www-`, `crewflow-`). |
| How is it resolved? | `core.resolve_workspace_by_host_label` (READY, active, org not suspended) → `workspace`; `core.resolve_released_host_label` → `renamed` (canonical = DB label + env); else `not-found`. Apex / APP_URL / ACCOUNTS_URL / CORS_ORIGINS hosts / reserved **Host** label (e.g. the API itself) → `none` (default host). |
| What does it grant? | Nothing. It can only **refuse**: an authenticated request from a workspace host whose workspace ≠ the session's server-derived `ctx.workspaceId` gets 404 `WORKSPACE_HOST_MISMATCH` (identical body for other / unknown / reserved / renamed / malformed hosts; only the caller's own canonical URL in it). `/auth/logout` is exempt. |
| Origin trust (CORS + cookie CSRF + login provenance + `/auth/refresh` + OAuth handoff) | `CORS_ORIGINS` exact, or **exactly** the canonical origin of a registry-confirmed READY workspace (scheme = https in production, else APP_URL's; exact port). Reserved, unknown, CREATING/FAILED, suspended and released labels never. Master switch `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED` (default off), and it now **requires** `WORKSPACE_HOST_ROUTING_ENABLED` (boot refused), because the wrong-host 404 is what contains a trusted workspace origin. |
| Cache | Existing `CoreEntityCacheService` epoch cache, kind `workspace_host_label` keyed `<global epoch>:<label>`; positive ≤60 s, negative ≤10 s; invalidated after commit on rename (old+new), READY/FAILED (provisioning) and org suspension/reactivation (global epoch). `isTrustedOrigin` stays synchronous and reads a per-process snapshot (`WorkspaceOriginTrustRegistry`, positive-only, 30 s) that the middleware and CORS callback refresh on every request. Toggle: `CORE_ENTITY_CACHE_ENABLED`. |
| Emails (C14) | Member-invitation "sign in" link = invited workspace's canonical host when routing is on and the workspace is routable (label read under the invitation's verified context, confirmed against the registry), else `APP_URL/login`. Activation / reset / email-change stay on `ACCOUNTS_URL` (token-bearing, central). Links to a renamed host redirect to the canonical host during S2's quarantine (90 days). |
| Mobile | Unaffected: Bearer on the API host, no Origin → host context `none`. Tested. |

### Request flow

```
browser ──► (proxy? XFH only if peer ∈ TRUSTED_PROXY_CIDRS) ──► Nest
  CORS callback ─ ensure(Origin) ─► registry (Redis epoch cache ─► core.resolve_workspace_by_host_label) ─► ACAO or none
  WorkspaceHostMiddleware ─► req.workspaceHost = none | workspace | renamed | not-found | unavailable
                          └► ensure(Origin) → WorkspaceOriginTrustRegistry (sync snapshot)
  guards: JwtAuthGuard (cookie CSRF uses isTrustedOrigin → snapshot) → ctx.workspaceId from DB membership
  WorkspaceHostConsistencyInterceptor: ctx && host≠none && host.workspaceId≠ctx.workspaceId ─► 404 WORKSPACE_HOST_MISMATCH
  handler → service → org/workspace-scoped query → RLS (unchanged)
web: WorkspaceHostGate ─ GET /public/workspace-host ─► default | workspace(branding) | not-found screen
     | renamed → location.replace(validated canonical + path) | any 404 MISMATCH → wrong-host screen (no data, own URL, sign out)
```

## 2. What changed

- **Server** — new `engine/core-modules/workspace-host/` (types, `request-host.util`, lookup, resolver, origin trust, middleware,
  interceptor, public controller, module); `environment.service.ts` (registry-backed `isTrustedOrigin`, `canonicalWorkspaceScheme`,
  `workspaceOriginLabel`), `workspace-origin-trust.registry.ts`, `environment.module.ts`, `environment-variables.ts`
  (`WORKSPACE_HOST_ROUTING_ENABLED`), `env.validation.ts` (3 rules), `main.ts` (CORS callback), `app.module.ts`;
  `core-entity-cache.service.ts` (value-dependent TTL, `currentEpoch`, 2 kinds); `organisation-suspension.service.ts` +
  `platform-admin.module.ts` (invalidate on suspend/reactivate); `modules/manager-workspace/**` (batched availability inside the write
  transaction, own-workspace exclusion, suggestions endpoint + DTO, free-provider list, S2 SQLSTATE mapping, rename quarantine audit,
  invalidation, rename throttle); `member-invitation.service.ts` + `membership.module.ts` (canonical sign-in link).
- **Shared** — `utils/hostname.ts` (+spec), reserved list + prefixes aligned to S2 (TS list is a subset of S2's seed).
- **Web** — `features/workspace-host/` (gate, screens, mismatch watcher, spec), `shared/lib/workspace-host.ts`, `App.tsx` (gate above
  `SessionBootstrap`), `Login.tsx` ("Sign in to <workspace>"), `CreateWorkspaceScreen.tsx` (accurate preview, "Suggest an address"),
  `MyWorkspaceDomainsPage.tsx` (accurate URL, rename confirmation with quarantine warning), `WorkspaceDomainsPage.tsx` (org slug shown
  as an identifier, never as `<slug>.<base>`), `vite.config.ts`; removed `shared/hooks/useDomainConfig.ts` (+spec): it inferred
  previews from the browser hostname.
- **Other** — `.env.example`, worker-bundle env allowlist (+`WORKSPACE_HOST_ROUTING_ENABLED`, otherwise the worker would refuse to
  boot with trust on), `THREAT-MODEL.md`, `docs/HANDOFF.md`.
- **Tests updated to the new semantics** — `environment.service.spec.ts`, `env.validation.spec.ts`, `origin-trust.integration.spec.ts`
  (unregistered labels no longer trusted), `manager-workspace-abuse-cases` (audit `toMatchObject`), `App.spec.tsx` (gate is async).

## 3. Abuse cases and test results (observed)

| Suite | Result |
|---|---|
| `workspace-host-routing.integration` (real HTTP/session/RLS/Redis; registry lookup stubbed, cache ON and OFF) | **40/40 passed** |
| Server unit: workspace-host (3 specs), environment (2), cookie-csrf, subdomain, manager-workspace create | **212/212 passed** (`unit-server.log`) |
| `@rab/shared` `hostname.spec` | **32/32 passed** |
| Front full suite (`--maxWorkers=4`) | 682/683; the 1 failure (`ShiftApprovalDrawer.spec`, untouched) passed 17/17 on its own re-run — timing flake under load |
| Front `WorkspaceHostGate.spec` + App + onboarding + auth specs | **145/145 passed** (`unit-front.log`) |
| `origin-trust.integration` + `manager-workspace-abuse-cases` | **29/29 passed** |
| Worker-bundle launcher (`node --test`) | 18 pass, 0 fail, 12 skipped (Linux/image-only) |
| Regression sweep, 82 suites (see §3.1) | 1352 passed, 12 failed — none caused by lane H after one spec update |
| `host-label-registry-contract.integration` (REAL S2 functions) | **PENDING INTEGRATION** — skipped (4) unless `HOST_LABEL_CONTRACT_DB=1`; not run, no private DB built (see §8) |

Abuse cases covered (all in the passing suites above): unknown label → not-found (no fallback); reserved labels (list + `api-`,
`crewflow-`, `xn--`) → not-found / never trusted; released (quarantined) label → `renamed` + never trusted; renamed redirect target
only from DB label (server) and validated again (front: foreign host, look-alike suffix, path, http, reserved, `javascript:`,
protocol-relative path → no redirect); spoofed `X-Forwarded-Host` from an untrusted peer ignored, multi-valued refused; wrong-host
session → 404 with identical body for 4 host kinds, handler never runs, cross-workspace write not applied (DB checked), Bearer +
wrong Origin refused; mobile Bearer/no-Origin unchanged; cookie CSRF from renamed/unknown origin 403; CORS ACAO only for the canonical
READY origin (not other port / https-in-dev / unknown / reserved / renamed); malformed hosts (nested, port, `..`, trailing dot);
stale cache after rename (cache on and off, plus a negative control proving invalidation is load-bearing); suspension
`invalidateAll`; flags off → zero behaviour change and no registry lookups; front states default / workspace / not-found / renamed /
wrong host / resolver down / garbage response.

### 3.1 Regression sweep

`regression.log`: every integration suite that sends an Origin or touches suspension, invitations or manager workspaces (52 files,
excluding S2's and A2's in-progress suites), plus all `src/engine` unit specs and `modules/manager-workspace`: **82 suites, 1352 passed,
12 failed**. Breakdown of the 12:
- `cookie-csrf.util.spec` ×1 — asserted wave-1 shape-only trust; **updated** to registry semantics; passes (`regression-rerun.log`, `unit-server.log`).
- `tenant-context.service.spec` ×3, `identity-security-table-rls` ×2 — the known pre-existing failures (phase 0 §1, wave-1 reports).
- `server-path-provisioning-db` ×1 (§12.15) — `provisionWorkspaceSchema` fails with SQLSTATE 42P01 at "apply": raw-SQL provisioning on
  the test DB, no lane H code on that path (likely the parallel schema lanes' template/ledger not being on 15436). Reproduced alone.
- `containment-suspend-test-accounts` ×5 — its `beforeAll` (jest.setTimeout 30 s) exceeds 30 s on this shared DB; reproduced alone.
  **Warning for the coordinator:** this suite TRUNCATEs every `test-<uuid>` organisation (CASCADE) in its `beforeAll`; I ran it twice
  during this lane while lane A2 shares 15436 — if A2 saw fixtures vanish mid-run, this is why. It should not be in a shared-DB sweep.

## 4. Contract with lane S2

Built against `CONTRACT.md` v1 (now "IMPLEMENTED", no signature change). Uses `resolve_workspace_by_host_label`,
`resolve_released_host_label`, `workspace_subdomain_taken` (batched via `unnest`, `public.citext` cast because the tenant transaction's
search_path excludes `public`), `host_label_quarantine_interval` (probed with `to_regprocedure` first, so it is optional pre-integration),
and maps `23505`/`23P01`/`23514 host_label_reserved`/`23514 host_label_shape`. **Requests to S2:** (1) add `display_name text` (workspace
name, public branding) to `resolve_workspace_by_host_label` — the lookup already reads it if present; today the login page shows the label;
(2) a public logo is not served (needs a narrow DEFINER read or signed URL) — deferred; (3) confirm the TS reserved list stays a subset.

## 5. Production enablement (owner-gated, in order)

1. Owner decisions in §9; pick the base as a **dedicated sub-zone** (e.g. `workspaces.rabworkspaceteams.co.uk`) so the API
   (`api.rabworkspaceteams.co.uk`), app and accounts hosts are outside it.
2. Approve and apply S2's `HostLabelNamespace1786719820000` in production (it is dev/test-only today); review its collision report first.
3. DNS/TLS per §7; serve the same SPA build on `*.<base>`.
4. Set on **both** `rab-api` and `rab-worker`: `WORKSPACE_BASE_DOMAIN=<base>`, `WORKSPACE_HOST_ROUTING_ENABLED=true`, then (separate
   approval) `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true`. Optional `CORE_ENTITY_CACHE_ENABLED=true`.
5. Verify: `GET /rest/v1/public/workspace-host` from a READY host, an unknown host, the apex; a cross-workspace session gets 404.
   Rollback: set the flags to `false` and recreate both containers.

## 6. Local dev at `http://<label>.localhost:5173`

Browsers resolve `*.localhost` to loopback. A SameSite=Lax cookie for `localhost:3000` is cross-site from `acme.localhost:5173`, so dev
uses a same-origin Vite proxy: the API sees `Host: acme.localhost:5173` (no XFH needed), and each workspace host gets its own
host-only session (sign in on that host). Vite allows `.localhost` hosts (`allowedHosts`), extra via `VITE_ALLOWED_HOSTS`.

**Exact compose values for the coordinator** (`packages/rab-docker/docker-compose.yml`, not edited by this lane):
- `server` and `worker` environment: `WORKSPACE_BASE_DOMAIN: localhost:5173`, `WORKSPACE_HOST_ROUTING_ENABLED: 'true'`,
  `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: 'true'` (the worker needs the same pair or it refuses to boot).
- `front` environment: `VITE_API_URL: /rest/v1` (replaces `http://127.0.0.1:3000/rest/v1`), `VITE_API_PROXY_TARGET: http://server:3000`.
- Keep `CORS_ORIGINS`/`APP_URL` as they are; open the console at `http://localhost:5173` (default host) or `http://<label>.localhost:5173`.

## 7. DNS / TLS / Cloudflare / custom domains (design only — nothing live touched)

- **DNS:** `*.workspaces.<domain>` CNAME → the static front (and nothing else); never a wildcard on the apex. Keep the API on its own
  name outside the sub-zone. Monitor dangling records (a deleted front target with a live wildcard = takeover).
- **TLS:** a wildcard certificate for `*.workspaces.<domain>` (one level only — nested labels are refused by the parser anyway);
  CAA records restricting issuers. HSTS `max-age=31536000; includeSubDomains` on the workspace sub-zone and apex (the Vercel config
  already sends it for the front), preload only after every subdomain is HTTPS.
- **Proxy:** set `TRUSTED_PROXY_CIDRS` to the exact proxy addresses if a proxy terminates in front of the API and the same-origin
  topology is used; it must overwrite (not append) `X-Forwarded-Host`.
- **Cloudflare for SaaS (custom domains, C12, deferred):** new `core.workspace_custom_domain` (workspace_id, organisation_id, hostname
  unique, status PENDING|ACTIVE|FAILED|REMOVED, cf_custom_hostname_id, verification token, verified_at; FORCE RLS; writes via
  DEFINER only). Flow: owner requests a hostname → CF custom hostname created → ownership proven by CF's TXT/HTTP DCV **and** our own
  TXT `_crewflow-verify.<host>` → ACTIVE. Resolver and origin trust read ACTIVE rows only. **Takeover prevention:** refuse our own
  domains and any hostname another workspace holds; periodic re-verification (CNAME still points to us, else FAILED + untrusted); on
  workspace deletion/suspension or domain removal delete the CF custom hostname immediately; webhook with a timing-safe secret.
  Cookies on a custom domain are cross-site to the API (needs SameSite=None or a same-origin proxy) — decide with A2.

## 8. Not done / follow-ups

- Real-function contract suite not run: building `crewflow-lane-h-db` (15453) needs the multi-phase bootstrap (roles, phase A as owner,
  phase B as bootstrap superuser) and the coordinator asked to avoid extra heavy processes; S2 reports its own 9/9 on its DB. Run
  `HOST_LABEL_CONTRACT_DB=1 jest --runInBand src/__tests__/integration/host-label-registry-contract.integration.spec.ts` after integration
  (its `audit_log.entity_type` column assumption is unverified).
- Cross-host login handoff (C8, with A2); logo on the public login page; worker-side invalidation is not needed (the provisioner path
  goes through `WorkspaceProvisioningService`, which invalidates).

## 9. Owner decisions

1. Production `WORKSPACE_BASE_DOMAIN` (recommend a `workspaces.` sub-zone) and enabling the two flags (separately).
2. Topology: fixed API host + Origin (works with today's SameSite=None cookies) vs same-origin proxy per workspace host (per-host cookies).
3. Should sign-in on a wrong workspace host be refused up front (Twenty-style) instead of the session being refused afterwards?
4. Quarantine length (S2: 90 days) and rename rate (5/hour per client here; per-workspace cap?).
5. Show the workspace display name publicly on its login page (needs S2 change)? Logo too?
6. Should the default host auto-redirect a signed-in manager to their canonical host?

## 10. Security trade-off (for veto)

```
SECURITY TRADE-OFF: the synchronous isTrustedOrigin reads a per-process snapshot of registry answers (positive-only, 30 s TTL),
refreshed by the middleware/CORS callback on every request, instead of making all five consumers async (two are lane A2's files).
Stricter alternative: async predicate everywhere. Residual: a caller that consults it without the middleware having run in the
same request can see a positive answer up to 30 s old (none exists today); rename/suspension clear the snapshot in-process at once.
```
