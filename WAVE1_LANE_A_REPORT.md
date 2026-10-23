# Wave 1, Lane A: authentication and security

Branch: `feat/twenty-parity-foundation`. Nothing was committed, pushed or deployed. Tests ran only on the disposable
`crewflow-test-db` (127.0.0.1:15436). No migration was written or needed.

Inputs:
- `CREWFLOW_ULTIMATE_PARITY_PHASE0_REPORT.md` §3.2 (B2, B5, B6, B1/D-A3), §3.3 (C9) and §3.4 (D-C1, D-A1, D-A2, D-A3).
- Owner decisions:
  - Lockout: per email + IP, slowing down.
  - Password-off sessions: "log them out" (2026-10-23, received mid-lane).

## 1. Findings (§5.8 format), all FIXED in this lane

### D-C1: credentialed origin trust of any workspace-shaped sibling host

```
[MEDIUM]   (phase-0 rating; coordinator brief calls it HIGH)
Failure:    JS on any <label>.<WORKSPACE_BASE_DOMAIN> host (api., admin., mail., a taken-over or third-party sibling)
            → sends credentialed requests (SameSite=None cookies) to the API → acts as the signed-in victim.
Actor:      unauthenticated attacker controlling script on any sibling host.
Location:   packages/rab-server/src/engine/core-modules/environment/environment.service.ts:61-95 (was :61-90).
            Consumers: main.ts CORS, cookie-csrf.util.ts, credential-request-provenance.guard.ts,
            auth.controller.ts /auth/refresh, oauth-handoff.controller.ts.
Root cause: Case 2 of isTrustedOrigin trusted any label of valid shape, with no opt-in, no reserved-label exclusion and no
            canonical-Origin check.
Fix:        Case 2 now applies only when WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true (default false). Boot is refused when
            the flag is true and WORKSPACE_BASE_DOMAIN is unset. With the flag on, isTrustedOrigin rejects:
              - labels in RESERVED_SUBDOMAINS (@rab/shared);
              - xn-- labels;
              - any Origin that is not exactly url.origin (path, userinfo, upper case, trailing slash);
              - any other port;
              - http in production.
            Every consumer uses this one predicate.
Regression: environment.service.spec.ts, cookie-csrf.util.spec.ts, origin-trust.integration.spec.ts.
```

Wave 3 design note (not built): replace the shape check with `core.workspace_host_routable(label)`. It would be a SECURITY
DEFINER function that is true only for a registered, READY, active workspace in an organisation that is not suspended. The
result would be cached through `CoreEntityCacheService` (kind `workspace_by_subdomain`, TTL 60 s or less, negative TTL 10 s
or less). It would be invalidated on rename, READY/FAILED and organisation suspension. The flag stays as the master switch,
and the no-Origin mobile path is unchanged.

### D-A1: targeted login lockout

```
[MEDIUM]
Failure:    anyone who knows an email → 10 wrong passwords → every sign-in for that account (from anywhere) refused 15 min,
            repeatable indefinitely.
Actor:      unauthenticated remote attacker.
Location:   auth.service.ts:161-173 (old), core.auth_count_recent_login_failures.
Root cause: Counted per EMAIL only, checked before the password, and enforced as a hard lock for every source.
Fix:        New LoginAttemptLimiterService (auth/services/login-attempt-limiter.service.ts). It reuses the existing atomic
            Redis token bucket (rate-limit/token-bucket.ts) on the bounded auth-cache client. There are three buckets, all
            debited atomically:
              1. per (normalised email, client IP), burst: 5 per 15 min;
              2. per (normalised email, client IP), daily: 30 per 24 h;
              3. account-wide: 50 per 15 min, applied only to addresses that have not signed in to this account in the
                 last 30 days.
            Behaviour:
              - Buckets refill, so the limiter slows attempts down and never locks the account.
              - A refused attempt writes nothing.
              - The client IP is resolved by resolveClientIp (TRUSTED_PROXY_CIDRS).
              - admit() runs before the account lookup for every address, so the response is uniform.
              - Success clears that (email, IP)'s counters only after the session is issued.
              - A refusal after a correct password (password-off, MFA, app-denied) clears nothing (no oracle).
              - If Redis fails, the request fails closed: 503 RATE_LIMIT_UNAVAILABLE plus Retry-After (CF-17 policy).
            The old DB lockout call has been removed. The wrong-email/wrong-password argon2 uniformity is unchanged.
Regression: login-attempt-limiter.integration.spec.ts, which runs with the REAL limiter (RAB_DISABLE_RATE_LIMIT=false).
```

### D-A2: password sessions survive "password sign-in disabled"

```
[LOW]
Failure:    org admin disables password sign-in → existing password sessions (≤180 d) keep working.
Location:   organisation-auth-providers.service.ts update() (now :119-150).
Root cause: The toggle only bumped security_version.
Fix:        Owner decision "log them out". On a true→false change, PasswordSessionRevocationService runs in the SAME
            transaction as the setting change:
              - It revokes every live auth_provider='password' session of that organisation through
                RefreshTokenService.revokeFamily (refresh family + user_session + security_version).
              - The organisation's security version is bumped.
              - An audit row organisation.password_sessions_revoked is written ({revoked, exempt, reason}), and
                organisation.auth_providers_updated gains passwordSessionsRevoked.
              - Google/Microsoft sessions are untouched.
              - Exempt: the mobile workforce, i.e. exclusively staff/venue_manager on their own app. This is the same
                passwordExemptForMobileWorkforce predicate the login gate uses, so those users could sign in again
                with a password anyway.
              - A failure rolls the setting back.
Regression: password-provider-disabled-wave1.integration.spec.ts.
```

The login enforcement itself (CF-06, `AuthService.completeLogin`) was verified. It is the only password-session-issuing path.
- `refresh` and `step-up` issue no new password session.
- `activate-account` and `reset` issue no session.
- `/auth/login` web and mobile both go through `completeLogin`.

New tests cover the direct service call, a direct API call with no Origin and the mobile header, and cross-organisation
"account switching" (the same email in two orgs: org B's setting neither bypasses nor blocks org A).

### D-A3: MFA gate not consulted on password login

```
[LOW, latent]
Failure:    once a second factor is required, password (web/mobile) and direct provider sign-in would skip it.
Location:   auth.service.ts completeLogin (gate now :344-353); login-second-factor-policy.service.ts.
Root cause: The policy was consulted only by the OAuth handoff.
Fix:        The SAME LoginSecondFactorPolicyService.requirementFor is called in completeLogin. It runs after every access
            gate and before any session, login_history success row or provider link. Any answer other than 'none' returns
            409 SECOND_FACTOR_REQUIRED and issues nothing.
            INERT BY DEFAULT: the policy still returns 'none', because enrolment and verification (TOTP) are wave 4.
            The doc comment was corrected.
Regression: login-second-factor-gate.integration.spec.ts (policy stubbed to verify/enroll).
```

The web login page does not yet handle a 409 on password sign-in. That is wave-4 UX; it is unreachable today.

### B2: legacy APP_SECRET JWT key cannot be retired

```
[LOW]
Location:   access-token.service.ts.
Fix:        APP_JWT_LEGACY_VERIFY_ENABLED, default TRUE (behaviour unchanged). With no keyring configured, `legacy` is
            also the SIGNING key, so defaulting it to false would reject every token. When false:
              - the `legacy` kid is deleted from the verify map, so a kid-less or kid="legacy" token is an unknown kid;
              - boot is refused unless APP_JWT_SIGNING_KEYRING and APP_JWT_ACTIVE_KID are set (env.validation.ts and
                the constructor).
            Values must be strictly true/false; a typo refuses to boot.
Cut-over (wave 2): deploy the keyring, wait 15 min (one access TTL), then set the flag to false.
Regression: access-token.service.spec.ts (valid / legacy / kid-less / expired / no-keyring), env.validation.spec.ts.
```

## 2. New environment variables

All are added to `.env.example` and to the worker-bundle `JOBS_ENV_KEYS`. Launcher test 14 passes.

| Variable | Default | Notes |
|---|---|---|
| `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED` | `false` | strict boolean; true requires `WORKSPACE_BASE_DOMAIN` |
| `APP_JWT_LEGACY_VERIFY_ENABLED` | `true` | strict boolean; false requires a keyring |
| `AUTH_LOGIN_EMAIL_IP_BURST` / `_WINDOW_SECONDS` | `5` / `900` | |
| `AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT` | `30` | per 24 h |
| `AUTH_LOGIN_ACCOUNT_BURST` / `_WINDOW_SECONDS` | `50` / `900` | unknown addresses only |
| `AUTH_LOGIN_KNOWN_IP_TTL_DAYS` | `30` | 1 to 90 |

The flag name differs from phase 0's suggested `WORKSPACE_HOST_ROUTING_ENABLED` on purpose. Origin trust and wave-3 host
routing (C5) should be separately switchable.

## 3. Files changed

**Server** (`packages/rab-server/src/engine/core-modules/`):
- `environment/environment-variables.ts`
- `environment/env.validation.ts`
- `environment/environment.service.ts`
- `auth/services/auth.service.ts`
- `auth/services/login-attempt-limiter.service.ts` (new)
- `auth/services/password-session-revocation.service.ts` (new)
- `auth/services/organisation-auth-providers.service.ts`
- `auth/services/login-second-factor-policy.service.ts` (doc)
- `auth/token/services/access-token.service.ts`
- `auth/controllers/auth.controller.ts` (Retry-After on 503, doc)
- `auth/guards/cookie-csrf.util.ts` (doc)
- `auth/auth.module.ts`
- `audit/audit.service.ts` (new action `ORGANISATION_PASSWORD_SESSIONS_REVOKED`; the column is free text, so no migration)
- `throttler/throttler.module.ts` (doc)

**Tests:**
- Unit: `environment.service.spec.ts`, `env.validation.spec.ts`, `access-token.service.spec.ts`, `cookie-csrf.util.spec.ts` (new).
- Integration (all new): `login-attempt-limiter`, `login-second-factor-gate`, `password-provider-disabled-wave1`, `origin-trust`.
- Helper: `helpers/throttle-state.ts` (`clearLoginLimiterState`).

**Other files:**
- `packages/rab-server/.env.example`
- `packages/rab-docker/rab/worker-bundle/start-worker-bundle.cjs` (allowlist only, per the coordinator)
- `THREAT-MODEL.md`
- `docs/HANDOFF.md`

## 4. Tests

These are the runs observed in this lane. Logs are in `docs/evidence/wave1-lane-a/`.

| Run | Result |
|---|---|
| Unit: environment + token + cookie-csrf | 7 suites, 165/165 passed (`unit1.log`) |
| `login-attempt-limiter.integration` (real limiter) | 10/10 passed |
| `login-second-factor-gate.integration` | 6/6 passed |
| `origin-trust.integration` | 9/9 passed |
| `password-provider-disabled-wave1` + `password-provider-disabled` + `p1c1b` + `p1d` | 4 suites, 50/50 passed |
| Worker-bundle launcher (`node --test`) | 18 pass, 0 fail, 12 skipped (Linux-only); test 14 passes |
| Auth regression sweep: all `src/engine` unit specs + 35 auth/session/OAuth/rate-limit/settings integration suites (`regression.log`) | 57 suites run: 55 passed, 2 failed, 2 skipped. Tests: **743 passed, 5 failed, 2 skipped (750)** |

### 4.1 The 5 regression failures are pre-existing

None of them is caused by this lane. All are already listed as known failures in `CREWFLOW_FOUNDATION_FIXES_REPORT.md`
and phase 0 §1:
- `tenant-context.service.spec` ×3: a stale SQL-string expectation.
- `identity-security-table-rls` ×2: test-DB grant visibility.

Neither file is touched by this lane. The first `rate-limiting` run in `baseline-int.log` hit a 5 s hook timeout on a
cold AppModule compile; it passes when run with `--testTimeout=120000`.

## 5. For lane S / coordinator

- **No migration is required.** `core.auth_count_recent_login_failures` is no longer called by application code. It is still
  listed in `identity-security-table-rls.integration.spec.ts`; dropping it is optional, belongs to lane S, and is not urgent.
- **Wave 2:** set `APP_JWT_SIGNING_KEYRING`/`APP_JWT_ACTIVE_KID` in each environment, then `APP_JWT_LEGACY_VERIFY_ENABLED=false`.

## 6. Open owner decisions

1. **Lockout thresholds** (5 per 15 min, 30 per day, account 50 per 15 min, known-IP 30 days) are proposals. They are
   tunable by env without a code change.
2. **Distributed attack residual.** During an active distributed attack, the owner signing in from a NEVER-seen address is
   slowed. Do we want CAPTCHA or step-up there (wave 4)?
3. **Mobile-workforce sessions are exempt** from the password-off revocation, because they would be allowed to sign in with
   a password again immediately. If the owner wants them logged out too, change one predicate in
   `password-session-revocation.service.ts`.
4. **Enabling `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED` anywhere.** Recommended: keep it off until wave-3 registry trust exists.
