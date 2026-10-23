# Wave 2, Lane A2: auth hardening (key separation, JWT rotation, `__Host-` cookies)

Branch `feat/twenty-parity-foundation`. Nothing committed, pushed or deployed. Tests ran only on the disposable
`crewflow-test-db` (127.0.0.1:15436). **No migration needed** (see §7 for one optional follow-up for lane S2).
Evidence: `docs/evidence/wave2-lane-a2/`.

Inputs: `CREWFLOW_ULTIMATE_PARITY_PHASE0_REPORT.md` §3.2 B2/B3, `WAVE1_LANE_A_REPORT.md` (B2 flag),
`CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md` §3.17.

## 1. APP_SECRET inventory (verified in code before the change)

| Use | Before | After |
|---|---|---|
| Access-token HS256 signing (`AccessTokenService`) | raw APP_SECRET as kid `legacy` when no keyring | kid `derived-v1` = HKDF-SHA256(APP_SECRET, `crewflow:key-purpose:v1:jwt-access:derived-v1`); raw APP_SECRET is verify-only (`legacy`, kid-less) behind `APP_JWT_LEGACY_VERIFY_ENABLED` |
| Access-token verification | keyring kids + raw APP_SECRET | keyring kids + `derived-v1` + `legacy`; flag false removes `legacy` always and `derived-v1` once a keyring is active |
| Auth-context cache HMAC (`AuthContextCacheService`, F-06) | HMAC(APP_SECRET, label) | `APP_AUTH_CACHE_HMAC_KEY` (HKDF'd) or HKDF(APP_SECRET, `…:auth-cache-hmac:derived-v1`); key id stored per entry |
| Secret encryption legacy key | HKDF(APP_SECRET, `rab-secret-encryption`) | unchanged (existing ciphertext); keyring path unchanged |
| QR attendance tokens (`modules/attendance`) | HKDF(APP_SECRET, `rab-qr-token-v1`) | unchanged: printed QR codes would break; out of engine scope |
| CSRF / session material | none (Origin allowlist; random session tokens, SHA-256 hashed) | none |

## 2. Findings and changes (§5.8 format)

### B2-KS: one secret in several key roles

```
[MEDIUM]
Failure:    anyone who obtains the JWT signing key (logged/dumped secret, a debug endpoint, an operator copy) → also holds the
            cache-MAC key and the HKDF root of the legacy encryption and QR keys → forges sessions AND forges trusted
            auth-cache entries (isPlatformAdmin) AND decrypts legacy ciphertext.
Location:   access-token.service.ts:64 (raw APP_SECRET signing key), auth-context-cache.service.ts:74, env.validation.ts (no
            reuse check between keyrings).
Root cause: APP_SECRET used directly as an HMAC key in two roles; keyrings could share a secret.
Fix:        keyring.util.ts (new): derivePurposeKey (HKDF-SHA256, info = purpose + kid), shared keyring parser (now refuses
            duplicate kids), weakKeyMaterialReason, keyMaterialProblems / productionKeyMaterialProblems.
            AccessTokenService: default signer `derived-v1`; reserved kids `legacy`, `derived-v1`; legacy flag semantics above.
            AuthContextCacheService: own purpose key + key id (`k`) per entry; foreign key id = quiet miss.
            Boot: same secret in two roles refused in every environment; weak keys refused in production (folded into the
            existing production rules, names only); APP_KEY_SEPARATION_REQUIRED=true demands keyring + legacy off + cache key.
Regression: keyring.util.spec.ts, access-token.service.spec.ts (wave 2 block), auth-context-cache.key-separation.spec.ts,
            env.validation.spec.ts, wave2-auth-cookies-keys.integration.spec.ts §C.
```

Wave-1 rule change: `APP_JWT_LEGACY_VERIFY_ENABLED=false` **no longer needs a keyring** (the signer is never raw APP_SECRET);
the env rule and its test were updated accordingly.

**SECURITY TRADE-OFF (keyring kids stay raw HMAC keys).** Keyring secrets are still used directly as the HS256 key, not
HKDF'd, so any token already issued under a deployed kid keeps verifying. Separation for them rests on the boot-time reuse
refusal. Stricter alternative: HKDF every kid (one forced refresh for tokens under existing kids). Veto if wanted.

**SECURITY TRADE-OFF (rolling deploy).** The default signer changes from `legacy` to `derived-v1` at deploy. An instance still
on the old code does not know `derived-v1`; a token minted by a new instance and presented to an old one gets one 401, which the
web/mobile refresh-on-401 recovers. Old `legacy` tokens keep verifying on new instances. Production runs one API container, so
the overlap is the restart window.

### B2-ROT: rotation without abrupt invalidation

Config path (no code change needed per rotation): `APP_JWT_SIGNING_KEYRING` holds every verifiable kid; `APP_JWT_ACTIVE_KID`
picks the signer. Helper (no DB, no Nest): `src/command/jwt-keyring-plan.ts` (`add <kid>` generates a 48-byte secret and appends;
`retire <kid>` refuses the active kid). Tests: valid / expired / unknown kid / legacy / kid-less / cross-kid substitution /
full derived-v1 → k1 → k2 rotation (unit), revoked-session and legacy-token acceptance (integration).

### B3: cookie tossing (`__Host-`), behind `AUTH_COOKIE_HOST_PREFIX_ENABLED` (default false)

```
[LOW→MEDIUM once workspace subdomains serve content]
Failure:    script on a sibling host (or plain-http content on the API host) sets crewflow_session / rab_rt / OAuth cookies
            with Domain=<parent> → the victim's browser presents the attacker's session (login CSRF) or a planted OAuth
            tx/handoff cookie → victim signed into the attacker's account.
Location:   web-session-cookie.constants.ts, refresh-cookie.constants.ts, oauth-cookies.constants.ts (no prefix), jwt-auth.guard.ts:200.
Root cause: un-prefixed cookie names; CF-14 only catches the case where two copies arrive.
Fix:        auth-cookie-policy.ts (new, single source of names/attributes) + auth-cookie-migration.service.ts (new).
            Flag on: `__Host-crewflow_session`, `__Host-rab_rt`, `__Host-crewflow_oauth_tx`, `__Host-crewflow_oauth_handoff`,
            HttpOnly, Secure, Path=/, no Domain, SameSite unchanged. Guard reads only the __Host- session cookie.
            Migration (AUTH_COOKIE_LEGACY_MIGRATION_ENABLED, default true): /auth/refresh (Origin-checked) accepts ONE legacy
            rab_rt when no __Host-rab_rt exists, rotates it (legacy value is then single-use-dead), promotes the legacy
            session cookie only if it resolves to the same session as that refresh family, clears both legacy names.
            Both names present → __Host- wins, legacy cleared. Duplicate legacy rab_rt → 401 DUPLICATE_SESSION_COOKIE.
            Login/OAuth completion clear legacy copies and revoke a session behind a leftover legacy cookie. Logout clears
            both names. OAuth cookies: no legacy fallback (an in-flight sign-in at the switch restarts).
            Flag off: byte-identical names, paths and attributes (unit-asserted against the legacy builders, and in HTTP).
Regression: auth-cookie-policy.spec.ts, wave2-auth-cookies-keys.integration.spec.ts §A/§B.
```

The web client needs **no change**: in host mode a legacy browser gets `401 Missing credentials` from `/auth/me`, which
`api.ts` already answers with `/auth/refresh`, which performs the migration; the next page load is cookie-authenticated.

**SECURITY TRADE-OFF (migration window).** While migration is on, a planted legacy `rab_rt` of the attacker's own session can
still be rotated into `__Host-` names in a browser that has no `__Host-` cookie yet: the same exposure as today, no worse.
End it with `AUTH_COOKIE_LEGACY_MIGRATION_ENABLED=false` (recommended 30 days after the switch: the manager_web idle window).

**SECURITY TRADE-OFF (Path=/).** The prefix requires Path=/, so `__Host-rab_rt` (previously `/rest/v1/auth`) is sent to every
API path. Every cookie-reading route is under `/rest/v1` (only `/healthz` is outside, and it reads no cookie), the refresh cookie
is only honoured by Origin-checked `/auth/refresh`, and `crewflow_session` (same lifetime, same power) already travels to every
`/rest/v1` route. Alternative: stop issuing `rab_rt` to web (phase 0 suggestion), which changes the legacy-session refresh path
and the front; not done here.

**Host-only per-workspace sessions (design, not built).** Every cookie is host-only; `__Host-` makes a per-workspace cookie on
`<ws>.<base>` safe against sibling workspaces (same-site, so SameSite cannot separate them). The cross-host handoff stays a
later joint step with lane H.

## 3. JWT rotation runbook

1. `node dist/command/jwt-keyring-plan.js add 2026-11` (reads current `APP_JWT_SIGNING_KEYRING`/`APP_JWT_ACTIVE_KID`). Store the
   printed JSON in the secret store only.
2. Deploy it with `APP_JWT_ACTIVE_KID` unchanged. On every API instance, `secret:rotate --check-keyring` must list `2026-11`.
3. Set `APP_JWT_ACTIVE_KID=2026-11`, deploy.
4. Wait ≥ 15 min (access TTL) + clock skew after the last instance flipped.
5. `jwt-keyring-plan.js retire <old>`, deploy.
6. First move off APP_SECRET: steps 1–4, then `APP_JWT_LEGACY_VERIFY_ENABLED=false` (drops `legacy` and `derived-v1`), then set
   `APP_AUTH_CACHE_HMAC_KEY` and finally `APP_KEY_SEPARATION_REQUIRED=true` to lock the end state.

Emergency (leaked kid): remove it at once; tokens under it 401 once and clients refresh. Refresh tokens are DB rows, unaffected.
ES256/JWKS: deferred (no external verifiers; phase 0).

## 4. Environment variables (all in `.env.example`, `JOBS_ENV_KEYS`, strict validation)

| Variable | Default | Notes |
|---|---|---|
| `APP_AUTH_CACHE_HMAC_KEY` | unset (HKDF of APP_SECRET) | ≥32 chars, must not equal any other key |
| `APP_KEY_SEPARATION_REQUIRED` | `false` | strict boolean; true = keyring + legacy off + cache key required |
| `AUTH_COOKIE_HOST_PREFIX_ENABLED` | `false` | strict boolean; needs an https API origin |
| `AUTH_COOKIE_LEGACY_MIGRATION_ENABLED` | `true` | strict boolean; read only when the prefix is on |
| `APP_JWT_LEGACY_VERIFY_ENABLED` (wave 1) | `true` | semantics widened (see §2); false no longer needs a keyring |

Production now also refuses a weak `APP_SECRET`/keyring/cache secret (<8 distinct characters, or placeholder wording).
**Before deploying, confirm the production APP_SECRET passes** (any `openssl rand` value does); otherwise the API and Worker
refuse to boot (cf. the 2026-10-22 crash-loop).

## 5. SameSite analysis and recommendation

Site = scheme + registrable domain (eTLD+1, Public Suffix List); ports are ignored by SameSite, not by CORS.

| Topology | Origin | Site | Cookie that works | Notes |
|---|---|---|---|---|
| (a) dev `http://127.0.0.1:5173` → `http://127.0.0.1:3000` | cross-origin | **same-site** (same host, scheme http) | Lax (current) | `localhost:5173` → `127.0.0.1:3000` is **cross-site**; keep one host form. `__Host-` needs Secure: Chrome/Firefox accept Secure on localhost/127.0.0.1, Safari does not, so keep the prefix off in http dev. |
| (b) `app.<d>` → `api.<d>` | cross-origin | **same-site** | Lax would work (fetch from a same-site page) | provably safe only once both hostnames are confirmed under one non-PSL registrable domain |
| (c) Vercel front (`*.vercel.app`, on the PSL) → API on another domain | cross-site | **cross-site** | only `None; Secure` | also exposed to third-party-cookie blocking (Safari ITP, Firefox ETP, Chrome tracking protection): sign-in can break regardless of our settings |
| (d) `<ws>.<d>` → `api.<d>` (future) | cross-origin | same-site; workspaces are same-site **with each other** | Lax works | SameSite gives no isolation between workspaces: Origin allowlist (lane H) + `__Host-` are the controls |

Recommendation: **keep SameSite as is** (None in production, Lax in dev) because the production front is on Vercel and its
hostname is not in the repo. Owner action: serve the console on a custom domain sibling to the API (topology b); then switch
production to Lax (one line in `auth-cookie-policy.ts`), which also removes the third-party-cookie risk of (c). CSRF protection
(Origin allowlist on every unsafe cookie request, on `/auth/refresh` and on OAuth completion; JSON-only login) is retained in
every case and does not depend on SameSite.

## 6. Files

New: `secret-encryption/keyring.util.ts` (+spec), `auth/constants/auth-cookie-policy.ts` (+spec),
`auth/services/auth-cookie-migration.service.ts`, `auth/services/auth-context-cache.key-separation.spec.ts`,
`src/command/jwt-keyring-plan.ts` (+spec), `__tests__/integration/wave2-auth-cookies-keys.integration.spec.ts`.
Changed: `access-token.service.ts` (+spec), `secret-encryption.service.ts` (shared parser), `auth-context-cache.service.ts`,
`jwt-auth.guard.ts`, `auth.controller.ts`, `oauth-sign-in-flow.service.ts`, `auth.module.ts`, `environment-variables.ts`,
`env.validation.ts` (+spec), `.env.example`, `start-worker-bundle.cjs`, `SECURITY.md`, `THREAT-MODEL.md`, `docs/HANDOFF.md`.
All paths under `packages/rab-server/src/engine/core-modules/` unless shown.

## 7. Tests (observed runs, logs in `docs/evidence/wave2-lane-a2/`)

| Run | Result |
|---|---|
| `tsc --noEmit -p tsconfig.app.json` | clean |
| Unit: token, secret-encryption, auth constants/services, jwt-keyring-plan, env.validation (`unit1.log` + rerun) | 189 tests: 188 passed, 1 failed. The failure is lane H's in-flight rule ("origin trust requires WORKSPACE_HOST_ROUTING_ENABLED") against a wave-1 test; not this lane. The wider auth+environment unit run also showed 6 `isTrustedOrigin` failures (environment.service.spec ×5, cookie-csrf.util.spec ×1) from lane H's in-flight `environment.service.ts` |
| `wave2-auth-cookies-keys.integration` (new, `int-wave2.log`) | 18/18 passed |
| Auth regression: 25 integration suites (cookie, OAuth handoff/legacy, CSRF, sessions, cache integrity, secret rotation, limiter, rate limiting, realtime) (`regression-int.log`) | 24 suites passed, 1 failed. Tests: 278 passed, 2 failed, both in `origin-trust.integration` (workspace-subdomain trust now gated by lane H's host routing/registry, `environment.service.ts`) |
| Worker launcher `node --test` (`launcher.log`) | 17 passed, 1 failed, 12 skipped (Linux-only). Test 14's only missing key is lane H's `WORKSPACE_HOST_ROUTING_ENABLED`; all four lane-A2 keys are in `JOBS_ENV_KEYS` |

## 8. Owner decisions

1. Approve turning on `AUTH_COOKIE_HOST_PREFIX_ENABLED` in production (no forced re-login thanks to migration; in-flight Google/
   Microsoft sign-ins at the switch restart). Then, after ~30 days, `AUTH_COOKIE_LEGACY_MIGRATION_ENABLED=false`.
2. Production topology: custom console domain sibling to the API → SameSite Lax (§5).
3. Deploy dedicated `APP_JWT_SIGNING_KEYRING` + `APP_AUTH_CACHE_HMAC_KEY`, then `APP_JWT_LEGACY_VERIFY_ENABLED=false` and
   `APP_KEY_SEPARATION_REQUIRED=true` per environment.
4. The two trade-offs in §2 (raw keyring kids; Path=/ for the refresh cookie) and whether to stop issuing `rab_rt` to web.
5. QR token and legacy encryption keys remain APP_SECRET-rooted (QR rotation would void printed codes; encryption needs
   `secret:rotate --apply` first).
6. Optional for lane S2 (not needed now): a SECURITY DEFINER `rotate_web_session_token(session_id, old_hash, new_hash)` would let
   the migration mint a NEW session value instead of renaming the existing one. Renaming is safe (no new secret, same session),
   so this is hardening only.
