# Wave 4, Lane MFA: TOTP second factor, recovery codes, step-up, cross-host login handoff

Branch `feat/twenty-parity-foundation`. Nothing committed, pushed or deployed (the coordinator commits). No migration was
written: the schema is lane DB5's (`MfaTotpRecoveryCodes1786719900000`, `LoginHandoff1786719910000`, contract
`docs/evidence/w45-db5/CONTRACT.md` §1–2, dev/test only, not production-approved). DB-dependent tests ran only on a PRIVATE
disposable database, `crewflow-lane-mfa-db` (127.0.0.1:15462, tmpfs, phase A + phase B, the same procedure as the shared test
DB), built from the DB5 migration files as they were at sha256 `978e6310…` (mfa-schema-sql.ts) / `fa4967b0…`
(login-handoff-sql.ts) — `docs/evidence/w4-mfa/db/`. The container and its Redis db 7 keys were removed after the final
runs (rebuild scripts: session scratchpad `mfa/{mkdb,migrate,env}.sh`). `rab-devdb` and `crewflow-test-db` were not touched; no container was
restarted; `issac@gmail.com` was not used. Evidence: `docs/evidence/w4-mfa/`.

Inputs: phase 0 §3.2 B1 (MFA) and §3.3 C8 (login handoff), wave 1 lane A (gate wiring, D-A3), wave 2 lane A2 (cookie policy,
purpose keys), wave 3 lane H (resolver/registry, per-host sessions), Twenty `two-factor-authentication/` (read at
`C:\OGCRM\twenty-main`).

## 1. What was built

| Area | Server | Web |
|---|---|---|
| TOTP | `auth/mfa/totp.ts` — RFC 4226/6238 (HMAC-SHA1, 6 digits, 30 s, ±1 step), returns the MATCHED step, constant-time compare over the whole window; RFC 4226 App. D + RFC 6238 App. B vectors in `totp.spec.ts` | — |
| Storage | `auth/mfa/mfa-store.ts` — the only caller of DB5's `core.mfa_*` functions (tenant from `current_org()`); secret = `SecretEncryptionService` RAB2 envelope of the hex seed | — |
| Factor primitives | `services/mfa-factor.service.ts` — verify (TOTP via `mfa_accept_totp_step`, or recovery code via `mfa_consume_recovery_code`), stage, confirm, regenerate, disable | — |
| Sign-in challenge | `services/mfa-challenge.service.ts` (Redis, single use, attempt-bounded), `services/mfa-login.service.ts`, `AuthService.completeLogin` gate + `completeChallengedLogin`; routes `POST /auth/mfa/challenge/{verify,enrolment,enrolment/confirm,cancel}` in `AuthController` | `features/auth/mfa/MfaChallengeStep.tsx` used by `Login.tsx` and `OAuthCallbackComplete.tsx` (also `/login#mfa=` from legacy OAuth mode) |
| Policy | `services/login-second-factor-policy.service.ts` (real now: enrolled ⇒ `verify`; enforced class without factor ⇒ `enroll`; mobile exempt by default) | — |
| Self-service | `services/mfa-management.service.ts`, `controllers/mfa.controller.ts` (`GET /auth/mfa`, `POST /auth/mfa/{enrolment,enrolment/confirm,recovery-codes,disable}`) | `features/settings/account/TwoFactorSection.tsx` (Settings → Account) |
| Step-up | `services/step-up-reauth.service.ts` (`assertPasswordAndSecondFactor`, `stepUp` + `assertRecentStepUp`, `assertCurrentPassword(…, mfaCode?)`), `POST /auth/step-up` | — |
| Admin reset | `MfaManagementService.adminReset`, `POST /admin/users/:userId/mfa/reset` (PlatformAdminGuard) | `features/settings/admin-panel/ResetTwoFactorDialog.tsx` (Admin Panel → General → Recent users "Reset 2FA"; Organisations → CEO) |
| Login handoff | `auth/login-handoff/{login-handoff.service,controller,module}.ts`, `AuthService.issueHandedOffSession`; `POST /auth/login-handoff`, `POST /auth/login-handoff/exchange` | `features/auth/workspaceHandoff.ts` (after sign-in on the default host), `features/auth/LoginHandoffLanding.tsx` (route `/auth/handoff`) |
| Shared UI | — | `features/auth/mfa/{mfaApi.ts,EnrolmentQr.tsx,RecoveryCodesList.tsx}` (QR is a server-rendered PNG data URL via the repo's existing `qrcode` dependency; nothing is sent to a third party; codes are only in component state; "download" is a local Blob) |

Other edits: `audit.service.ts` (14 `user.mfa_*` / `auth.step_up_*` / `auth.login_handoff_*` actions), `login-attempt-limiter.service.ts`
(`admitSecondFactor`), `oauth-sign-in-flow.service.ts` (handoff summary no longer guesses `secondFactor`; the 409 challenge passes
through; legacy mode redirects to `/login#mfa=…`), `auth.module.ts`, `app.module.ts`, env vars (+`.env.example`, worker
`JOBS_ENV_KEYS`), `shared/api.ts` (pre-session routes), `App.tsx` (route). Tests updated to the new semantics:
`login-second-factor-gate` (call shape; 409 now carries a challenge), `google-oauth-handoff` T27 (the 409 consumes the handoff and
carries the challenge), `OAuthCallbackComplete.spec` (real code step instead of the "not available" screen).

## 2. Flows

- **Enrol (settings):** password → server generates + stages the secret (`mfa_stage_totp_secret`) → QR/manual key shown once →
  first code confirms (`mfa_replace_recovery_codes` then `mfa_enable_totp(step)`: that step is burned) → 10 recovery codes shown once →
  every OTHER session ends, security version +1.
- **Sign-in (password, Google, Microsoft, web and — if policy says so — mobile):** first factor + every access gate → policy →
  `409 SECOND_FACTOR_REQUIRED {requirement, challengeToken, challengeExpiresAt}`; no session, no success row, no provider link →
  `verify` (code or recovery code) → challenge consumed atomically → `completeChallengedLogin` re-checks status, security version,
  suspension, app access, membership, password-provider setting, writes the deferred provider link, issues the session.
- **Enrolment required (enforced class, no factor):** same 409 with `requirement: 'enroll'` → `challenge/enrolment` →
  `challenge/enrolment/confirm` → MFA on, codes returned once, other sessions ended, session issued. Never a lockout.
- **Disable / regenerate:** password + current code (TOTP or recovery) in the same request; disable refused while enforced;
  disable ends every other session.
- **Admin reset:** platform admin, not self, admin must have MFA, password + admin's current TOTP; clears target factor + codes,
  revokes all target sessions, +1 security version, audit rows in both organisations.
- **Login handoff:** sign-in on the default host (normal host-only session there) → front calls `POST /auth/login-handoff` → server
  (session's own workspace only, registry-confirmed canonical origin, DB audience cross-checked) returns
  `<canonical>/auth/handoff#t=<token>` (or `null`: stay) → front validates and `location.replace`s → landing strips the fragment,
  POSTs `{token}` → `login_handoff_consume(hash, <this request's resolved label>)` → brand-new host-only session (presented session
  cookies on that host revoked) → source session revoked. Platform admins / users without a routable workspace stay on the default host.

### 2.1 Step-up coverage (brief item 5)

| Operation | Proof required now |
|---|---|
| MFA enrolment start | current password |
| MFA disable, recovery-code regeneration | password + current TOTP or recovery code (always) |
| Platform-admin MFA reset of another user | admin password + admin's current TOTP (always; admin must have MFA) |
| `POST /auth/step-up` grant (reusable by any service via `assertRecentStepUp`) | password + factor when enrolled |
| Existing password step-up sites: platform-admin grant/revoke, organisation suspend/reactivate, user deletion (manager, venue manager, staff), email change | password; + factor (inline `mfaCode` or a recent step-up grant) when `AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS=true` |
| Candidates to adopt next (not changed: other lanes' files / dialogs) | organisation auth-provider toggles, SMTP config, maintenance mode, role-permission edits, member role change, "sign out other devices" |

## 3. Twenty (`two-factor-authentication.service.ts`, `totp.strategy.ts`) — weaknesses not copied

| Twenty | Here |
|---|---|
| `authenticator.check()` boolean: **no replay protection** | matched step recorded atomically; same/older/parallel replay refused |
| secret encryption key = `userId + workspaceId + 'otp-secret'` | AES-256-GCM keyring (`SecretEncryptionService`), purpose-separated HKDF keys (A2) |
| a PENDING method within 1 h re-returns the same secret to whoever asks | every start stages a NEW secret, needs the password; nothing re-displays an old secret |
| no recovery codes in the service | 10 × 80-bit, hashed, single use |
| no attempt limit in the 2FA service | per challenge (5), per user across IPs (10/15 min), per IP route throttle |

## 4. Findings (§5.8 format)

```
[MEDIUM → FIXED]  D-A3 closed for real: the second-factor gate existed on every path (wave 1) but answered 'none'.
Failure:   a CEO / Initial Manager / platform admin password alone signed in on every provider.
Location:  login-second-factor-policy.service.ts (was hard-coded 'none'); auth.service.ts completeLogin.
Fix:       real policy + single-use challenge at the same convergence point; OAuth (handoff + legacy) and password paths share it.
Regression: mfa-totp-wave4.integration.spec.ts (all), login-second-factor-gate.integration.spec.ts, google-oauth-handoff T27.
```

```
[LOW, found in integration → FIXED BY DB5 before my final run]  core.login_handoff_create first used pg_catalog.greatest(),
which does not exist (GREATEST is a SQL construct) → every create returned 500. Seen on the first private-DB build; DB5's
current file uses unqualified LEAST/GREATEST; the DB was rebuilt and the suite passes. Regression: login-handoff-wave4 (all).
```

## 5. Security trade-offs (for veto)

```
SECURITY TRADE-OFF (TOTP implementation): no OTP library is in the repo (otplib 12 exists only in the machine's global Yarn
cache); installing one mid-wave rewrites node_modules under other lanes' running suites. RFC 6238 is implemented with
node:crypto HMAC (the reviewed primitive) + RFC 4226 truncation, verified against both RFCs' published vectors. Stricter
alternative: add otplib@12 (or @otplib/core) and keep `verifyTotp`'s contract (return the matched step). Owner/coordinator call.
```

```
SECURITY TRADE-OFF (mobile exempt): AUTH_MFA_MOBILE_POLICY=exempt by default because the Flutter/iOS apps have no code screen.
An ENROLLED manager-tier account (managers may use the mobile apps) can therefore still get a mobile session with the password
alone. Stricter: =require (mobile sign-in of enrolled/enforced users answers 409 until the apps support the challenge).
```

```
SECURITY TRADE-OFF (legacy step-up actions): AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS=false keeps platform-admin grant/revoke,
organisation suspend/reactivate, user deletion and email change password-only, because their dialogs (users/admin features,
other lanes) have no code field. MFA management and admin reset always require the factor. Stricter: set true (enrolled actors
must send `mfaCode` or do `POST /auth/step-up` first) once those dialogs gain the field.
```

```
SECURITY TRADE-OFF (recovery-code hash): SHA-256 (domain-separated), not DB5's suggested HMAC-SHA256. The codes are 80-bit
(DB5 assumed ~50-bit), so an offline preimage search on a leaked table is infeasible, and a peppered hash would silently void
every user's recovery codes on an APP_SECRET/keyring rotation. Stricter: HMAC under a dedicated, never-rotated pepper.
```

```
SECURITY TRADE-OFF (handoff login CSRF residual): the DB5 contract has no peek function, so the landing exchanges without a
"Continue as <email>?" confirmation. An attacker can mint a token for THEIR account on THEIR workspace host and send a victim
there within 30 s; audience binding keeps it off the victim's own workspace host. Stricter: a `login_handoff_peek` DEFINER
function + confirmation screen (requested from DB5).
```

```
SECURITY TRADE-OFF (challenge in Redis): pending challenges (email, first name, ids, provider link) live ≤ 5 min in Redis, keyed by
SHA-256 of the token; Redis down ⇒ MFA sign-ins refused (503). Stricter: a FORCE-RLS DB table via DB5.
```

Decision (not a trade-off): the exchange **revokes the source (default-host) session** so one sign-in yields one live web session.

## 6. Abuse cases (all observed passing on the private DB)

| Case | Test |
|---|---|
| replay of the same code (incl. the confirming code), older step inside the window, parallel replay (exactly one 200) | mfa-totp-wave4 "ABUSE: replay…" |
| wrong codes: per-challenge exhaustion (5 → destroyed; a correct factor then fails; nothing consumed) | "ABUSE: wrong codes exhaust…" |
| wrong codes spread over challenges + IPs hit one per-user bucket (429, nothing consumed; slowed, not locked) | mfa-attempt-limiter-wave4 (REAL limiter) |
| challenge reuse after success, expiry, forged/garbage token, web↔mobile switch, Redis holds only the hash | "…token reuse, expiry, garbage and transport switching" |
| account changed under a challenge (security version) | "ABUSE: a challenge dies…" |
| recovery code reuse; regeneration without factor / wrong password; old set invalid after regeneration | "ABUSE: a recovery code works exactly once…" |
| disable without step-up / stolen session (4 variants), `totpEnabled` field → 400, direct UPDATE as crewflow_app → 42501 | "ABUSE: disabling needs password AND…" |
| admin reset: non-admin 403, admin without MFA 403, self 400, wrong password/code 403, recovery code not accepted, success revokes sessions, audit in both orgs | "ABUSE: admin reset…" |
| enforced role without enrolment → enrolment flow (wrong step refused, bad code 401, success + codes + session), disable then refused, policy refusal burns nothing | "ABUSE: an ENFORCED role…" |
| enforcement off by default → no lockout | "enforcement defaults OFF…" |
| mobile unaffected by default; challenged with `require`; staff not reached by web enforcement | "mobile sign-in is unaffected…" |
| Google first-time link written only after the factor | "Google sign-in of an enrolled account…" |
| step-up: needs password + factor, audited, code burned | "step-up: …" |
| handoff: happy path (host-only, HttpOnly, no ids/tokens in body, source ended), replay, expiry, wrong audience (burned), default/unknown host, body cannot pick audience, open redirect (Host / XFH / body), login CSRF (bad/missing Origin, form body), fixation (planted cookie revoked), 6th live handoff → 429, no handoff for own host / platform admin / mobile Bearer, dies with logout and security version | login-handoff-wave4 (10) |
| front: open-redirect guard (13 hostile URLs), fragment stripped before the exchange, no retry on a dead token, codes acknowledged before continue, enforced user has no Turn-off | workspaceHandoff.spec, LoginHandoffLanding.spec, MfaChallengeStep.spec, TwoFactorSection.spec |

## 7. Tests run (observed; logs in `docs/evidence/w4-mfa/tests/`)

| Run | Result |
|---|---|
| `tsc --noEmit` rab-server (`tsconfig.app.json`) / rab-front (`tsconfig.app.json`) | exit 0 / exit 0 (`tsc-server.log`) |
| Server unit: auth (incl. new `totp.spec` RFC vectors, `recovery-codes.spec`, `mfa-env.validation.spec`, `login-second-factor-policy.service.spec`), environment, secret-encryption, workspace-host | 21 suites, **386/386** (`unit-server.log`) |
| Server unit, every non-integration spec | 71 suites: **900 passed, 3 failed, 1 skipped** — the 3 are the known `tenant-context.service.spec` stale-SQL failures (`unit-server-full.log`) |
| `mfa-totp-wave4.integration` (private DB, real DB5 functions, real Redis) | **12/12** (`int-mfa-1.log`, and again in the sweep) |
| `login-handoff-wave4.integration` (routing + trust + handoff on, real functions) | **10/10** (`int-handoff-1.log`, and again in the sweep). First build: 500s from DB5's then-current `pg_catalog.greatest` (§4); DB rebuilt from DB5's fixed files |
| `mfa-attempt-limiter-wave4` (REAL limiter) + `login-second-factor-gate` + `google-oauth-handoff` | 3 suites, **30/30** (`int-limiter-gate-oauth.log`) |
| Auth regression sweep on the private DB: every integration suite touching login/refresh/OAuth/step-up/`currentPassword` (53 files) | 50 passed, 2 skipped (opt-in), 1 failed: **819 passed, 2 failed, 6 skipped** — the 2 are the known pre-existing `identity-security-table-rls` grant-visibility pair (wave 1 §4.1) (`int-regression-sweep.log`) |
| rab-front full suite (`--maxWorkers=2`) | 72 suites, **709/709** (`front-full.log`); new: `MfaChallengeStep.spec`, `workspaceHandoff.spec`, `LoginHandoffLanding.spec`, `TwoFactorSection.spec`, updated `OAuthCallbackComplete.spec` |
| Worker-bundle launcher `node --test` | 18 pass, 0 fail, 12 skipped (Linux-only); test 14 (allowlist covers every declared var) passes |

Discarded run: one invocation meant to run unit specs only mis-parsed its ignore patterns and ran ALL 215 suites with two
workers (integration suites in parallel on the private DB, which they do not support) — 96 failures from shared-DB interference;
kept as `INVALID-accidental-parallel-all-suites.log` for transparency and not counted. It touched only the private DB and Redis
db 7. The serial sweep above is the valid integration result.

Not run: the shared `crewflow-test-db` (lacks DB5's migrations until integration — the three new suites fail loudly there, never
"pass"); mobile `flutter test` (no mobile change); `yarn lint` (not run alongside tests, per the brief).

## 8. Environment variables (all in `.env.example` and `JOBS_ENV_KEYS`; strict validation)

| Variable | Default | Notes |
|---|---|---|
| `AUTH_MFA_ENROLMENT_ENABLED` | `true` | new enrolments only; enrolled users are always challenged |
| `AUTH_MFA_ENFORCE_PLATFORM_ADMIN` / `_ORGANISATION_OWNER` / `_INITIAL_MANAGER` / `_OTHER_WEB_USERS` | `false` | strict booleans; enforcement = enrolment at next sign-in |
| `AUTH_MFA_MOBILE_POLICY` | `exempt` | `exempt` \| `require` |
| `AUTH_MFA_CHALLENGE_TTL_SECONDS` / `_MAX_ATTEMPTS` | `300` / `5` | 60–600 s / 1–10 |
| `AUTH_MFA_USER_ATTEMPTS_BURST` / `_WINDOW_SECONDS` | `10` / `900` | per user, all IPs |
| `AUTH_MFA_ISSUER` | `Crewflow` | authenticator label |
| `AUTH_STEP_UP_WINDOW_SECONDS` | `300` | 60–900 |
| `AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS` | `false` | see trade-off |
| `AUTH_LOGIN_HANDOFF_ENABLED` | `false` | boot refused unless `WORKSPACE_HOST_ROUTING_ENABLED` and `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED` are true |
| `AUTH_LOGIN_HANDOFF_TTL_SECONDS` | `30` | 10–60 |

Dev compose (coordinator, after DB5's migrations are on rab-devdb): add `AUTH_LOGIN_HANDOFF_ENABLED: 'true'` to `server` AND `worker`
(routing + trust are already on there). No other value is needed for MFA itself.

## 9. Rollout plan (staged, every step reversible by flag)

1. DB5 migrations on the target DB (owner approval for production; not in `production-migration-approval.ts`), then deploy this
   code with all flags at defaults: enrolment available, nobody forced, mobile exempt, handoff off. Nothing changes for anyone who
   does not enrol.
2. Platform admins enrol voluntarily (Settings → Account). Verify admin reset works between two admins. Then
   `AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true`.
3. Communicate to CEOs; after ~1 week `AUTH_MFA_ENFORCE_ORGANISATION_OWNER=true` (un-enrolled CEOs are walked through enrolment at
   their next sign-in, no lockout).
4. `AUTH_MFA_ENFORCE_INITIAL_MANAGER=true`, then (owner decision) `AUTH_MFA_ENFORCE_OTHER_WEB_USERS=true`.
5. After the mobile apps ship the challenge screen: `AUTH_MFA_MOBILE_POLICY=require`.
6. After the users/admin dialogs gain a code field: `AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS=true`.
7. Handoff: dev now (flag on, routing already on); production only with lane H's production enablement (base domain, routing,
   trust) — then `AUTH_LOGIN_HANDOFF_ENABLED=true`.
Rollback for any step: set the flag back to its default and restart api + worker. Enrolled users stay enrolled (a platform admin
can reset an individual).

Lost-device runbook: the user signs in with a recovery code and re-enrols (disable + enable with a recovery code); with no codes
left, a platform admin verifies identity out of band (call back on a known number / CEO confirmation) and uses "Reset 2FA".

## 10. Requests to other lanes / coordinator

- **DB5:** (1) optional `core.login_handoff_peek(token_hash, host_label)` → email/display name only, no burn, for a confirmation
  screen; (2) allow `crewflow_app` to set `user_session.mfa_verified_at` at INSERT (currently column-excluded) so sessions record when
  the factor was proven (the handoff copies it; today always NULL); (3) `core.mfa_rotate_totp_secret` for OPS's rotation (already
  requested by OPS).
- **OPS:** schedule `core.login_handoff_cleanup`; secret rotation coverage of `totp_secret_encrypted` (plaintext is the hex seed).
- **Email lane:** security notice e-mails on MFA enable/disable/admin reset (not built: email module is not this lane's).
- **Mobile (Flutter/iOS):** challenge screen for `409 SECOND_FACTOR_REQUIRED` → `POST /auth/mfa/challenge/verify` with the mobile
  header (server side already works and is transport-bound).
- **Coordinator:** files shared with other lanes this wave: `environment-variables.ts`, `env.validation.ts`, `audit.service.ts`,
  `start-worker-bundle.cjs`, `.env.example`, `app.module.ts` (additive blocks only).

## 11. Owner decisions

1. Enforcement order and dates (§9); whether `OTHER_WEB_USERS` is ever enforced.
2. Mobile: keep `exempt` until the apps ship (trade-off above) — or `require` now and accept that enrolled managers cannot use the
   mobile apps until then.
3. Library vs in-repo RFC 6238 (trade-off above).
4. Handoff confirmation screen (needs DB5 peek) vs current auto-exchange.
5. Recovery-code hash (SHA-256 vs peppered HMAC).
6. Who may reset a CEO's MFA besides platform admins (today: only platform admins; owner-approved default).
7. Should the source session survive the handoff (today: revoked)?
