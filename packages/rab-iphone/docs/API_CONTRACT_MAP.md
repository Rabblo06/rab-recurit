# API contract map: Crewflow native iPhone app

This is the contract the Swift networking and auth layer must match. It was taken from the **current local source** (see `SOURCE_BASELINE.md`), read on 2026-10-21. Server paths are relative to `packages/rab-server/src/`. Flutter paths are relative to `packages/rab-mobile/lib/`. `file:line` references are approximate pointers into a working tree that is still changing, so re-read the source before relying on an edge case.

Legend:
- **Staff** = `staff_app` token
- **VM** = `venue_manager_app` token
- **MW** = Manager Web only (`@ManagerApplication`), unreachable from either iPhone app

Deploy status uses the tags from `SOURCE_BASELINE.md` §3:
- **[DEV]** live on the dev DB per HANDOFF
- **[TEST-DB]** migration applied only to test DB 15436
- **[NOT-REBUILT]** code only, dev image not rebuilt

---

## 0. Transport rules (apply to every call)

| Topic | Rule | Source |
|---|---|---|
| Base URL | Build-time config `API_URL`, which **includes** `/rest/v1`. Request paths add only `/auth/...`, `/offers/...` and so on. Trailing slashes are stripped. Debug falls back to `http://localhost:3000/rest/v1` (Android: `10.0.2.2`). **Profile and release builds refuse to start without `API_URL`**, so there is never an implicit production host. Swift: put `API_URL` in an xcconfig/Info.plist key and fail at launch in Release if it is missing. | `core/api/api_client.dart:145-175` |
| Console URL | `CONSOLE_URL` (dart-define) is opened by the Manager/Admin "Open management console" screen. In debug it falls back to the API host on port 5173. | `navigation/console_entry_screen.dart:15-22` |
| Health | `GET /healthz` has **no** `/rest/v1` prefix and no auth. Terminus returns 200 `{status:"ok",...}` or 503. | `engine/core-modules/health/health.controller.ts` |
| Headers on every request | `Content-Type: application/json`, `Authorization: Bearer <access JWT>` (when one is held), `X-Client-Platform: mobile`. | `api_client.dart:289-300` |
| `X-Client-Platform: mobile` | **Mandatory on `/auth/login` and `/auth/refresh`.** It makes the server return the refresh token in the JSON body instead of the `rab_rt` HttpOnly cookie, and it derives the session target from the user's roles. Without it, `/auth/refresh` assumes `manager_web` and refuses a mobile family with 403 `APPLICATION_ACCESS_DENIED`. | `auth/constants/refresh-cookie.constants.ts:34-35`; `auth.controller.ts:140-186` |
| `X-Client-Capabilities: mfa-verify` | **Sent on every request by the iPhone app (2026-10-25), next to `X-Client-Platform`.** Declares that this build can finish a second-factor sign-in challenge. A mobile `verify` sign-in without it answers `409 CLIENT_UPDATE_REQUIRED {code, message}` (no challenge, no session). Client-asserted, never a credential: it can only enable the challenge path. Same value as Flutter. | `auth/constants/client-capabilities.ts`; `auth.service.ts` `completeLogin` (P3) |
| `X-Application-Target` | Optional. If sent, it must equal the token's target, otherwise 403 `APPLICATION_ACCESS_DENIED`. Flutter never sends it. **Recommendation: don't send it.** | `jwt-auth.guard.ts:174-175` |
| `X-Crewflow-Background: 1` | The request is fully validated but does **not** slide the idle-timeout window. Use it for automatic polling and background refresh. Flutter does not use it today, so its 30 s reconcile timer keeps sessions alive. | `jwt-auth.guard.ts:27,144`; `session-validity.service.ts:166-169` |
| No `Origin` header | A native client sends no Origin, so CORS and origin checks don't apply. If an Origin *is* sent on `/auth/login`, it must be trusted, otherwise 403 "Untrusted origin.". | `cookie-csrf.util.ts:51-54` |
| Request validation | Global `ValidationPipe({whitelist, forbidNonWhitelisted, transform})`. **Any undeclared body or query field returns 400** with `message` as a string **array**. Never send `organisationId`, `status`, `userId` and so on. | `main.ts:72-74` |
| Path ids | Any path param named `id` or ending in `Id` that is not a UUID returns **404 `{"message":"Not found."}`** (interceptor; runs after the auth guards). This also applies to `:deviceId` (see §6). | `engine/interceptors/uuid-path-params.interceptor.ts:4-28` |
| Error body shapes | (a) Plain Nest: `{statusCode, message: string \| string[], error}`. (b) Structured: `{code, message, ...extras}`, usually **without** `statusCode`; `STAFF_AVAILABILITY_CONFLICT` does include it. (c) Invalid transition: 409 plain `"Invalid transition: a -> b"`. (d) `EntityNotFound` / workspace routing: 404 `{statusCode:404,message:"Not found."}`. (e) Anything else: 500 `{statusCode:500,message:"Internal server error"}`. Swift: decode `code` when present, otherwise fall back to `message` (take the first element if it is an array). Never show 5xx text. Mirror `ApiException.userMessage` (`api_client.dart:35-110`). | `engine/filters/all-exceptions.filter.ts:48-107` |
| Success codes | `@Post` without `@HttpCode` returns **201**. That covers clock-in, clock-out, geofence-exit, `/attendance/:id/correct`, offer accept/decline, `/shifts/request` and `/push/devices`. Check-in and the report seat actions return 200. Logout, set-password, forgot-password, notification read and push deactivate return **204** (empty body). **Treat any 2xx as success.** | controllers |
| Empty body | A handler that returns `null` produces 200 with an **empty** body. Example: `GET /attendance/me/shift/:shiftId` when there is no attendance. Swift: an empty 2xx body means `nil`. | express adapter |
| Dates in responses | `toISOString()`: UTC with milliseconds, `"2026-10-21T09:00:00.000Z"`. Use `ISO8601DateFormatter` with `[.withInternetDateTime, .withFractionalSeconds]`, and tolerate a missing fraction. **Exceptions:** payroll `payday`, `period.start` and `period.end` are date-only `"YYYY-MM-DD"` (Europe/London). `attendanceVersion` has microseconds; treat it as an **opaque string** and echo it back unchanged. | `payroll-allocation.ts:38-39`; `shift-report.service.ts:29-30` |
| Dates in requests | `capturedAt`, `clockInAt`, `clockOutAt` and `staffAssignments[].startsAt/endsAt` **must carry `Z` or `±HH:MM`**, otherwise 400. Seconds are required. Send UTC `…Z`. | `dto/attendance-location.dto.ts:40-43`; `dto/record-attendance.dto.ts:28-36` |
| Server clock | No attendance time is ever taken from the client clock. Timers render `serverNow − clockInAt`, with `serverNow` anchored to a monotonic clock. `serverNow` comes from `/attendance/me/active`, `CheckInState`, the report detail and the report list, and `presentation.serverNow` on offers. **CLAUDE.md non-negotiable.** | Flutter `attendance.trustedNow` |
| Money | Always **integer pence as a JSON number**. Bigint columns go through `Number()`. Never parse money as `Double`. Use `Int64` and format at the edge (mirror `core/theme/money.dart`; a 0-pence rate shows "Rate not set", which is a flagged assumption). | mappers |
| Pagination | `page` (int ≥1, default 1) and `limit` (1..1000, **default 500** unless the route overrides it). The envelope **differs per route**: see each table. | `engine/dto/pagination.dto.ts` |
| Idempotency | **There is no `Idempotency-Key` header anywhere.** Repeat-safety comes from server state, per route (listed below). **Never auto-retry a non-idempotent POST** (clock-in, clock-out, accept, decline, `/shifts/request`) after a timeout or 5xx. Flutter treats these results as "uncertain" and reloads. | |
| Rate limits | Global: 120/min per IP. Auth: 5/min per IP. Attendance punches: +10/min per user. `/files/:id`: 240/min. `/files/:id/download`: 60/min. 429 sends `Retry-After` (seconds or HTTP-date); Flutter parses both (`api_client.dart:359-395`). On `@RateLimitRequired` routes with Redis down: 503 `RATE_LIMIT_UNAVAILABLE` with `Retry-After: 5`. | `throttler.module.ts`; `attendance-per-user-throttle.guard.ts` |
| Timeouts | Flutter: 30 s per request, 20 s per refresh. A timeout surfaces as 408 locally and **never** clears the session. | `api_client.dart:133-135` |

### 0.1 Mobile route allow-list (CF-08)

`JwtAuthGuard` checks, in this order (`jwt-auth.guard.ts:141-182, 262-342`):

1. Bearer missing → 401 "Missing credentials".
2. JWT invalid or expired → 401 "Invalid or expired access token". Refresh, then retry once.
3. Session revoked, idle-expired or absolute-expired → 401 "Please sign in again."
4. Account inactive → 401 "This account is no longer active."
5. Organisation suspended → 401 "This organisation has been suspended. Contact your administrator."
6. `@ManagerApplication` route with a mobile token → **403 `{code:"APPLICATION_ACCESS_DENIED", message:"This account does not have access to the Manager system."}`**.
7. Mobile token on a route without `@MobileApplication(<its target>)` → **403 `{code:"APPLICATION_ROUTE_DENIED", message:"This action is not available in this app."}`**.
8. `mustResetPassword` → 403 "You must set a new password before continuing." on every route except `/auth/me`, `/auth/set-password` and `/auth/logout`.
9. Infrastructure failure → **503 `{code:"AUTH_UNAVAILABLE"}`**. **Do not log out.**
10. Maintenance → 503 "This workspace is temporarily down for maintenance."

After the guard:

- `PermissionGuard` denial → 403 `"You do not have access to this. Ask an administrator if you need it."`.
- Services re-check permissions → 403 `"Permission required."`.
- Out-of-scope records are **404**, never 403.

Role → app mapping (`auth/application-access.ts:7-30`):

| Role | Apps allowed |
|---|---|
| `staff` | `staff_app` only |
| `venue_manager` | `venue_manager_app` only |
| `ceo`, `org_admin`, `super_admin`, `admin`, `manager`, platform admin | every target |
| `custom_*` | `manager_web` only |

The iPhone app routes on `/auth/me.roles`, the same way Flutter's `CurrentUser.presentation` does (`core/models/current_user.dart`):

1. `isPlatformAdmin` → admin (console entry)
2. contains `venue_manager` → **VM shell**
3. `manager` / `ceo` → console entry
4. `staff` → **Staff shell**
5. otherwise → "unsupported" screen

Presentation only. Every API still enforces its own authorisation.

---

## 1. Auth contract (full detail)

Sources: `engine/core-modules/auth/**`; Flutter `core/auth/auth_provider.dart`, `core/api/api_client.dart`.

### 1.1 Endpoints

| Method | Path | Mobile | Request | Response | Errors | Source |
|---|---|---|---|---|---|---|
| GET | `/auth/config?org=<slug>` | public | `org?` | 200 `{authProviders:{password,google,microsoft: bool}, invitationProviders:{google,microsoft}, domain:{scheme, workspaceBaseDomain\|null}}` | — | `auth.controller.ts:88-106` (Flutter does not call it) |
| POST | `/auth/login` | pre-auth. Throttle 5/min/IP, `RateLimitRequired`, JSON required (415 `JSON_REQUIRED` otherwise) | `{email: string (trimmed, IsEmail), password: string, applicationTarget?: "manager_web"\|"venue_manager_app"\|"staff_app"}`. **Flutter sends `{email, password}` only.** Recommended for iOS: omit `applicationTarget`. With `X-Client-Platform: mobile` the server then picks `venue_manager_app` if the user has the `venue_manager` role, otherwise `staff_app` (`auth.service.ts:322-324`). | **200** `{accessToken, refreshToken, refreshExpiresAt: ISO, sessionExpiresAt: ISO, mustResetPassword: bool}`. **No `user` object and no `expiresIn`**: call `GET /auth/me` next (Flutter always does). | 401 "Invalid email or password." (uniform message and timing; argon2 always runs). 401 `{code:"AMBIGUOUS_ACCOUNTS"}`. 401 organisation suspended. 403 `APPLICATION_ACCESS_DENIED` (e.g. a `custom_*` role). **429 account lockout** `{message:"Too many sign-in attempts. Please try again in 15 minutes.", retryAfter:900}` with `Retry-After: 900` after 10 failures in 15 min. 429 throttler. 503 `RATE_LIMIT_UNAVAILABLE`. 400 validation. | `auth.controller.ts:232-257`; `dto/login.dto.ts`; `auth.service.ts:148-407` |
| POST | `/auth/refresh` | pre-auth, 5/min | `{refreshToken}`. **Send `X-Client-Platform: mobile`.** | 200 `{accessToken, refreshToken, refreshExpiresAt, sessionExpiresAt}` | 401 "Invalid refresh token" / "Please sign in again." / "Refresh token expired" / **"Refresh token reuse detected — session revoked. Please log in again."** / organisation suspended. 403 `APPLICATION_ACCESS_DENIED` (the role no longer allows the target). 429. | `auth.controller.ts:259-277`; `auth.service.ts:551-626`; `token/services/refresh-token.service.ts` |
| GET | `/auth/me` | both; exempt from must-reset | — | 200 `{id, email, firstName, lastName, organisationId, roles: string[], mustResetPassword: bool, isPlatformAdmin: bool, sessionId: uuid, applicationTarget: string, sessionExpiresAt: ISO}`. Flutter parses the first 8 fields. | standard guard errors | `auth.controller.ts:302-308`; `auth.service.ts:676-722` |
| GET | `/auth/capabilities` | both | — | 200 object of flag → bool with **exactly 17 keys**: `staff.view, schedule.view, venue.view, offer.send, report.view, staffing_request.create, attendance.view, venue_manager.create, report.export, attendance.edit, review.create, staff.create, staff.deactivate, payroll.view, payroll.approve, payroll.calculate, payroll.mark_paid`. **Display hints only.** The VM app gates Users (`staff.view`), Reports/History (`report.view`), record/on-behalf/correct (`attendance.edit`) and send (`offer.send`, always false for VM) on these. | guard errors | `auth.controller.ts:108-129`; Flutter `venue_manager_provider.dart:213-223,259` |
| POST | `/auth/logout` | both; exempt from must-reset, active-account and suspended guards | `{refreshToken}` | **204** | 401 "Invalid refresh token" (token belongs to another user; nothing revoked) | `auth.controller.ts:279-300`; `auth.service.ts:638-656` |
| POST | `/auth/forgot-password` | pre-auth, 5/min | `{email, applicationTarget?}`. Flutter sends `{email}`. For a mobile caller the server forces `staff_app`. | **204 always** (no enumeration; padded to ≥150 ms) | 400, 429 | `auth.service.ts:771-847` |
| POST | `/auth/set-password` | both; exempt from must-reset; 5/min | `{newPassword}` | **204**. The password change **revokes the refresh families**, so the user must log in again (Flutter keeps the success screen, then returns to login). | 409 "Your password does not need to be reset."; 400 strength reasons (one joined string) | `auth.controller.ts:310-319`; `auth.service.ts:732-751` |
| POST | `/auth/reset-password` | pre-auth (web page) | `{token, newPassword}` | 200 `{applicationTarget, managerLoginUrl}` | 400 "This reset link is invalid or has expired." | `auth.service.ts:871-932`. Used by the web page, not the app. |
| POST | `/auth/activate-account` | pre-auth (web page) | `{token, newPassword}` | 200 `{applicationTarget, managerLoginUrl}` | 400 "This activation link is invalid or has expired." | `auth.service.ts:953-1008`. Web page. |
| GET | `/profile/sessions` | both (`@MobileApplication()`) | — | `[{familyId, deviceId\|null, userAgent, ip, ipScope, createdAt, lastActiveAt, isCurrentDevice}]` | — | `modules/identity/controllers/profile.controller.ts:36-41`; `profile.service.ts:239-262`. **No Flutter UI.** |
| DELETE | `/profile/sessions/:familyId` | both | — | 204 | 404 not yours; 403 "Log out to end your current session." | `profile.service.ts:284-297`. No Flutter UI. |
| DELETE | `/profile/sessions` | both | — | `{revokedCount}` (revokes all other sessions) | | No Flutter UI. |
| POST | `/profile/sessions/logout-all` | both | — | `{revokedCount}` (revokes all, including the current one) | | No Flutter UI. |

### 1.2 Token lifecycle

**Access JWT**
- HS256, `iss="rab-auth"`, `aud="rab-api"`, header `kid`.
- Claims: `sub, org, roles[], sid, applicationTarget, iat, exp`.
- **TTL 15 min**, clamped to the family deadline (`access-token.service.ts`, `session-policy.ts:86`).
- The client never reads permissions off the JWT.

**Refresh token**
- Opaque 64-char hex, stored hashed.
- **Rotated on every `/auth/refresh`** with no grace window. Presenting an already-rotated token is **reuse**: the whole family is revoked (`reuse_detected`, audited) and the call returns 401.
- Two concurrent refreshes with the same token are serialised `FOR UPDATE`, and the loser hits reuse.
- **Swift MUST single-flight refresh.** Use one in-flight `Task` that all 401s await; Flutter does this at `api_client.dart:397-401`.
- **Swift MUST persist the rotated refresh token before the access token.** If the app is killed between the two writes, the stored refresh token must still be the live one (`api_client.dart:180-186`, CF-19).

**Lifetimes** (`session-policy.ts:55-153`)

| | Absolute (family) | Idle timeout |
|---|---|---|
| Mobile worker roles (`staff_app`, `venue_manager_app`) | **90 days**, never slides | **7 days** |
| Manager-tier on any target | 180 days | 30 days |
| Platform admin | 24 h | 30 min |

- Each refresh token's own TTL is 30 days, clamped to the family deadline.
- The idle window slides on authenticated requests only when `last_seen_at` is more than 5 min old, and never for `X-Crewflow-Background: 1`.
- `/auth/refresh` does **not** slide it.

**401 retry rule (mirror exactly)**, from `api_client.dart:317-357`:
- On 401 from any non-`/auth/*` path (plus `/auth/me` and `/auth/logout`), refresh once, then replay once.
- The replay must use the same **token generation** captured at the original dispatch. If a logout or account switch happened in between, don't replay; surface "Your session changed while this was loading."
- Refresh 401/403 → clear tokens and go to login.
- A refresh timeout or 5xx keeps the tokens.

**Forced logout**
- Security-version bumps do **not** invalidate tokens directly. Roles and permissions are recomputed from Postgres on every request.
- What ends a session is revoking the refresh family: password set or reset, admin reset, revoke session, logout-all. After that, the next call returns 401 "Please sign in again." and the next refresh fails.
- On SSE, a security-vector change closes the stream (§7).

### 1.3 Login, bootstrap and lock flow (Flutter behaviour to reproduce)

`auth_provider.dart`, `app.dart` `_RootGate`.

**Phases:** `loading, biometricLocked, reauthRequired, offeringBiometricSetup, unauthenticated, mustResetPassword, authenticated`. The unlock state is **never persisted**: every cold launch starts locked.

**Cold launch**
1. No tokens → `unauthenticated` (Welcome is shown once per install, then Login).
2. Tokens present and biometric enabled for this exact user (`enabledUserId == sessionUserId == rememberedAccount.userId`), with a valid binding (`confirmedAt` not in the future, last **password** auth < 90 days) and hardware available → `biometricLocked`.
3. Otherwise → `reauthRequired` (password).
4. Tokens present but no biometric preference → `GET /auth/me`. 401/403 clears the tokens. Even on success the phase becomes `reauthRequired`, because "a restored server identity is not proof of local presence".

**Login**
1. `POST /auth/login`.
2. Store the tokens.
3. `GET /auth/me`.
4. Store `rab.sessionUserId` and the remembered account `{userId,email}`.
5. Set `lastFullAuthenticationAt = now`.
6. Then:
   - `mustResetPassword` → set-password screen;
   - else if biometrics are available and not validly enabled → offer setup once;
   - else `authenticated`.

A 429 sets a local cooldown from `retryAfterSeconds`.

**Biometric unlock**
1. Local biometric success.
2. Re-check the binding.
3. `GET /auth/me`. **The server decides.**
4. If `me.id` ≠ the remembered or session user → clear the tokens and expire the session.
5. A connectivity failure keeps the session for retry.

**90-day deadline (MOB-01/02)**
- Anchored to the last **password** login, never to the biometric confirmation.
- Enforced on resume and by one timer while the app is foregrounded.
- "Enable biometric" in Profile > Security is refused if the password auth is older than 90 days.

**Logout**
1. Bump the generation, so every in-flight request is fenced.
2. Best-effort `POST /auth/logout {refreshToken}` (10 s timeout).
3. Clear the tokens.
4. The remembered account and biometric trust are **kept**; a normal logout does not clear them.

**iOS addition:** call push `deactivate` **before** `/auth/logout`, while the access token is still valid. Logout does not deactivate push devices server-side (§6).

### 1.4 Secure storage keys (Flutter `flutter_secure_storage` → iOS Keychain)

| Key | Content | Lifetime | Source |
|---|---|---|---|
| `rab.accessToken` | access JWT | session | `api_client.dart:124` |
| `rab.refreshToken` | refresh token (written **first**) | session | `api_client.dart:125` |
| `rab.sessionUserId` | user id owning the stored tokens | session | `api_client.dart:188-195` |
| `rab.applicationTarget` | **legacy; deleted on every launch and logout** | — | `api_client.dart:121-122` |
| `rab.biometric.enabledUserId` | user id that enabled biometric unlock | account-owned, survives logout | `biometric_store.dart:11` |
| `rab.biometric.confirmedAt` | ISO UTC of the native biometric confirmation | survives logout | `biometric_store.dart:16` |
| `rab.biometric.lastFullAuthenticationAt` | ISO UTC of the last **password** login (90-day anchor) | survives logout | `biometric_store.dart:12-13` |
| `rab.biometric.rememberedAccount` | JSON `{userId, email}` | survives logout | `biometric_store.dart:15` |
| `rab.onboarding.hasSeenWelcome` | `"true"` | device, never cleared | `onboarding_store.dart:12` |
| `rab.push.deviceId` | opaque install id (Flutter: 32 hex, **not a UUID**, see §6) | install | `push_device_store.dart:19` |

- No password and no biometric data are ever stored.
- Swift: use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for tokens. Gate unlock with `LAContext` (`.deviceOwnerAuthenticationWithBiometrics`).
- Non-secret shift-colour assignments are a separate app-support JSON of hashed keys, with no shift ids on disk (`core/theme/shift_colour_store.dart`).

### 1.5 Password reset, activation and deep links

- **Forgot password** emails `${ACCOUNTS_URL}/reset-password?token=<64hex>&applicationTarget=staff_app` (TTL 1 h). Only ACTIVE accounts get one.
- **Admin reset:** `${ACCOUNTS_URL}/reset-password?token=…` (48 h).
- **Invite:** `${ACCOUNTS_URL}/activate-account?token=…` (24 h). Activation leaves the account INVITED; the **first successful `/auth/login` activates it**.
- `ACCOUNTS_URL` is a **web** domain. The links open `rab-front` pages (`features/auth/ResetPassword.tsx`, `ActivateAccount.tsx`), which offer **"Open the app" = `rab://login`** for staff and VM targets.
- **There are no universal links:** no `apple-app-site-association` exists.
- **iOS: register URL scheme `rab`, host `login`.** Android does the same (`AndroidManifest.xml:44-49`).
- Behaviour (`app.dart` `_ReturnToLogin`, CF-37): if signed in, only bring the app forward and **never sign out**. If not signed in, mark Welcome as seen and show Login. The link carries no token.

### 1.6 Google / Microsoft sign-in: NOT available to native iOS

`GET /auth/{google|microsoft}`, `.../callback` and `/auth/oauth/handoff{,/complete,/cancel}` are browser-only:
- PKCE and the nonce live server-side.
- A `crewflow_oauth_tx` cookie binds the transaction.
- There is one fixed web callback URL.
- The handoff `complete` requires a trusted `Origin` and issues **cookies only**.
- The target is forced to `manager_web`, so staff and VM users would get `APPLICATION_ACCESS_DENIED` anyway (`auth.service.ts:511`; `oauth-handoff.controller.ts:70-104`).

There is no native redirect URI, no client PKCE and no JSON token exchange. **iOS supports email + password only.** Hide the OAuth buttons. Flutter has none.

---

### 1.7 Two-factor authentication (account security step 1, 2026-10-24) — iPhone implemented 2026-10-25, NOT compiled

Source: `docs/account-security/STEP1_REPORT.md`; `auth/controllers/{auth,mfa}.controller.ts`, `auth/services/{mfa-login,mfa-management,step-up-reauth}.service.ts`. Swift: `Core/Authentication/SecondFactor.swift`, `SessionCoordinator` (`.secondFactor`), `Features/Authentication/TwoFactor/**`.

| Method | Path | Mobile | Request | Response | Errors (iOS handling) |
|---|---|---|---|---|---|
| POST | `/auth/login` (enrolled account) | pre-auth | as §1.1 | **409** `{code:"SECOND_FACTOR_REQUIRED", requirement:"verify"\|"enroll", challengeToken, challengeExpiresAt, message}` — nothing issued | `requirement:"enroll"` (enforced role, dormant while every `AUTH_MFA_ENFORCE_*` is off): iOS cancels the challenge and says to set up on the web. `409 CLIENT_UPDATE_REQUIRED` → update screen (M11). |
| POST | `/auth/mfa/challenge/verify` | pre-auth, 10/min/IP, CredentialRequestProvenanceGuard | `{challengeToken, code}` (6 digits, or a recovery code ≤64 chars) | 200 = the mobile `/auth/login` body (tokens) | 401 `MFA_CODE_INVALID {attemptsRemaining}` (true count; 0 ⇒ start again), 401 `MFA_CHALLENGE_EXPIRED`, 401 `MFA_CHALLENGE_EXHAUSTED`, 429 `MFA_RATE_LIMITED` + `Retry-After` (cooldown, challenge kept). **Never auto-retried; never refreshes.** |
| POST | `/auth/mfa/challenge/cancel` | pre-auth | `{challengeToken}` | 204 | best effort, 5 s, once |
| GET | `/auth/mfa` | both (`@MobileApplication`) | — | `{enabled, enabledAt, recoveryCodesRemaining, recoveryCodesTotal, enforced, enrolmentAvailable, mobileChallenged, hasPassword, linkedProviders, ssoReauthProviders}` | guard errors; refresh-eligible |
| POST | `/auth/mfa/enrolment` | both | `{currentPassword}` | `{otpauthUri, qrDataUrl, manualKey}` (iOS ignores the QR) | 403 no code = wrong password; 403 `MFA_ENROLMENT_DISABLED`; 409 `MFA_ALREADY_ENABLED` |
| POST | `/auth/mfa/enrolment/confirm` | both | `{code}` | `{recoveryCodes: string[]}` (shown once) | `MFA_CODE_INVALID` as 401 (today) or 400 (owner-approved change); matched by `code`; no refresh, no replay |
| POST | `/auth/mfa/recovery-codes` | both | `{currentPassword, code}` | `{recoveryCodes}` | 403 no code = wrong password; 403 `STEP_UP_MFA_INVALID`; 409 `MFA_NOT_ENABLED` |
| POST | `/auth/mfa/disable` | both | `{currentPassword, code}` | 204 | as above + 403 `MFA_REQUIRED_BY_POLICY` |

Not reachable from mobile: `POST /auth/step-up` and the SSO re-authentication (manager_web only). An account with `hasPassword:false` therefore cannot prove itself from the phone; the iOS screens say so.

## 2. Staff attendance (`/attendance`, Staff)

Source: `modules/attendance/controllers/attendance.controller.ts`; `services/attendance.service.ts`. Flutter: `features/home/attendance_provider.dart`, `core/models/attendance.dart`.

**`AttendanceSummary`** (`attendance.service.ts:84-192`):

| Field | Type / notes |
|---|---|
| id | uuid |
| status | AttendanceStatus |
| clockInAt | ISO |
| clockOutAt | ISO\|null |
| workedMinutes | int\|null |
| earnedPence | int\|null (provisional) |
| breakMinutes | int\|null |
| locationVerified | bool |
| clockOutMethod | `manual\|auto_geofence\|manager_correction\|manager_on_behalf`\|null |
| shiftId | uuid |
| startsAt, endsAt | the seat's own window |
| venueName, roleName | string |
| staffProfileId | uuid |
| staffName | string |
| venuePhotoFileId | string\|null **[DEV?]** |
| payrollStatus | PayrollRecordStatus\|null **[DEV]** |
| payrollApprovedPence | int\|null **[DEV]**; only when approved/processing/paid |
| clockInMethod | `staff\|manager_on_behalf\|manager_correction`\|null **[TEST-DB]** |
| checkInRequired | bool **[TEST-DB]** |
| checkedInAt | ISO\|null **[TEST-DB]** |
| checkInSource | `staff\|qr`\|null **[TEST-DB]** |

**`CheckInState`** **[TEST-DB]**: `{shiftId, checkInRequired, checkedInAt|null, checkInSource|null, locationVerified, distanceM: int|null, accuracyM: int|null, geofenceEnforced, window:{opensAt, closesAt}, clockedIn, alreadyCheckedIn, serverNow}`.
- `window` = [seat start − `CLOCK_IN_EARLY_MINUTES` (15), seat end + `QR_POST_SHIFT_GRACE_MINUTES` (120)].

**Location body** (`LocationFix.toJson`, `core/services/location_service.dart`): `{lat, lng, accuracyM, capturedAt}`.
- `capturedAt` = server anchor − fix age, in UTC `Z`.
- The server rejects a fix older than **120 s**, more than **30 s** in the future, or **not newer than the previous step's fix** (`LOCATION_STALE`).
- Accuracy cap: `min(100 m, venue radius)` under the strict policy, 100 m otherwise.
- Limits arrive in `/me/active.locationEvidence`.
- Flutter pre-checks accuracy and age client-side and sends no request if the fix fails.

| Method | Path | Mobile | Permission | Request | Response | Errors | Idempotency | Deploy |
|---|---|---|---|---|---|---|---|---|
| GET | `/attendance/me/active` | Staff | attendance.clock | — | 200 `{attendance: AttendanceSummary\|null, serverNow, clockInEarlyMinutes, locationEvidence:{maxAccuracyM, maxAgeSeconds, maxFutureSkewSeconds}}` | 403 | read | [DEV] (`locationEvidence` [TEST-DB]) |
| GET | `/attendance/me/history` | Staff | attendance.clock | `page?, limit?` (default 500) | 200 **plain array** `AttendanceSummary[]`, newest first. Statuses: clocked_out, under_review, approved, disputed, missing_clock_out. **The server does not filter by payroll.** History is "payroll-approved only" as a **client filter** on `payrollStatus ∈ {approved, processing, paid}` (`features/history/staff_history.dart`). | 400 | read | [DEV] |
| GET | `/attendance/me/shift/:shiftId` | Staff | attendance.clock | — | 200 `AttendanceSummary` **or empty body** | 404 non-UUID | read | [DEV] |
| GET | `/attendance/me/shift/:shiftId/team` | Staff | attendance.clock + workspace | — | 200 `[{displayName (first name or "Team member"), startsAt, endsAt, isYou}]`, confirmed seats only | 404 "Shift not found."; **503** "Team visibility is not available yet."; 403 | read | [DEV] |
| GET | `/attendance/me/shift/:shiftId/check-in` | Staff | attendance.clock | — | 200 `CheckInState` | 404 | read | **[TEST-DB]** |
| POST | `/attendance/check-in` | Staff | attendance.clock, 10/min/user | `{shiftId (uuid, required), qrToken? (1..4096), lat?, lng?, accuracyM?, capturedAt?}`. Flutter sends location only when `geofenceEnforced != false`, and **no QR on Check In**. | **200** `CheckInState` | 404; 409 `ATTENDANCE_FLAGGED_MISSING`, `SHIFT_NOT_CONFIRMED`, `SHIFT_NOT_OPEN`, `ALREADY_CLOCKED_IN`, `CHECK_IN_TOO_EARLY`(+`shiftStart`,`availableAt`), `CHECK_IN_WINDOW_CLOSED`, `INVALID_QR`(+`reason`), `GEOFENCE_MISCONFIGURED`, `LOCATION_REQUIRED`, `LOCATION_ACCURACY_TOO_LOW`, `LOCATION_STALE`, `OUTSIDE_GEOFENCE`(+`venueName`); 409 plain CAS lost; 429 | **Idempotent:** a repeat returns 200 with the original state and `alreadyCheckedIn:true` | **[TEST-DB]** |
| POST | `/attendance/clock-in` | Staff | attendance.clock, 10/min/user | `{shiftId, qrToken (required, the scanned QR text verbatim), lat?, lng?, accuracyM?, capturedAt?}` | **201** `AttendanceSummary` | 404; 409 `ATTENDANCE_FLAGGED_MISSING`; 409 **plain** "This shift is not confirmed for you." / "This shift is not open for attendance." (**no code** on clock-in); `ALREADY_CLOCKED_IN`; `CLOCK_IN_TOO_EARLY`(+`shiftStart`,`availableAt`); `CLOCK_WINDOW_CLOSED`; **`CHECK_IN_REQUIRED`** (checked before the QR; Flutter reloads the check-in state); `INVALID_QR`; location codes (strict only when `checkInRequired`; the fix must be newer than the check-in fix); 409 plain "You already have an active clock-in — clock out first."; 429 | **NOT replay-safe:** a repeat gives 409. Never auto-retry; on an uncertain result reload `/me/active`. | [DEV] (check-in coupling [TEST-DB]) |
| POST | `/attendance/clock-out` | Staff | attendance.clock, 10/min/user | `{qrToken (required), lat?, lng?, accuracyM?, capturedAt?}`. **No `shiftId`.** | **201** `AttendanceSummary` (`clocked_out`, `manual`) | 404 "No active clock-in found."; 409 `INVALID_QR` (`reason:"expired"` after end + 120 min); location codes; 409 plain "This attendance was already clocked out." | **NOT replay-safe** | [DEV] |
| POST | `/attendance/geofence-exit` | Staff | attendance.clock, 10/min/user | `{lat, lng (required), accuracyM?, capturedAt? (effectively required for check-in bookings)}`. No QR. Flutter does not start it for a venue known not to enforce. | **201** `AttendanceSummary` (`auto_geofence`) | 404; 409 plain "This venue has no geofence configured…"; **409 plain "You are still within the venue geofence."** (a safe no-op); `LOCATION_*`; 429 | inside-fence = no-op | [DEV] |

- **QR token:** the venue QR encodes a raw HS256 JWT (`iss rab-attendance`, `aud rab-qr`, payload `{shiftId, venueId, ver}`). The app sends it verbatim; it never parses or validates it.
- **No route returns a QR token or image** (see `BACKEND_DEPENDENCIES.md`).
- The Flutter scanner is `mobile_scanner` (`features/home/qr_scan_screen.dart`). Swift: AVFoundation `AVCaptureMetadataOutput` (`.qr`).
- **There are no break start/end routes;** `on_break` is never written.

---

## 3. Offers, shifts, venues, venue directory

Sources: `modules/offer/controllers/offer.controller.ts`, `modules/scheduling/controllers/scheduling.controller.ts`, `modules/staff/controllers/staff.controller.ts`, `modules/venue/controllers/venue.controller.ts`. Flutter: `features/offers/offers_provider.dart`, `core/models/offer.dart`, `features/venue_manager/venue_manager_provider.dart`, `send_shift_screen.dart`.

### 3.1 Staff offers

| Method | Path | Mobile | Permission | Request | Response | Errors | Idempotency | Deploy |
|---|---|---|---|---|---|---|---|---|
| GET | `/offers/mine` | Staff | offer.respond | `page?, limit?` | **plain array** `OfferSummary[]`, newest `sentAt` first; `[]` with no staff profile | 404 workspace routing | read | [DEV]; offerKind/check-in fields [TEST-DB] |
| POST | `/offers/:id/accept` | Staff | offer.respond | no body | **201** `JobOffer` entity. Flutter ignores it and reloads `/offers/mine`. On a VM-requested standard shift, accept **auto-confirms**, so `status` may already be `manager_confirmed`. **Replacement and standby offers never auto-confirm.** | 404 "Offer not found."; 409 `Invalid transition: staff_accepted -> staff_accepted` (repeat); 409 "This shift has been cancelled…"; 409 "…ended more than 5 hours ago…"; 409 "This offer has expired."; 409 "This offer was already responded to — please refresh and try again."; auto-confirm 409s (`SHIFT_FULL: …`, overlap), rolled back so the offer stays `pending` | **Not idempotent** (a repeat is 409) | [DEV] |
| POST | `/offers/:id/decline` | Staff | offer.respond | `{reason?}`. Flutter sends no body. | **201** `JobOffer` | 404; 409 `Invalid transition: declined -> declined` | not idempotent | [DEV] |

Flutter calls only `accept` and `decline`. Success is shown only after the server returns OK (`features/offers/offer_response_feedback.dart`).

**`OfferSummary`** (`offer.service.ts:69-235`):

| Field | Type / notes |
|---|---|
| id | uuid |
| status | OfferStatus |
| sentAt, expiresAt | ISO |
| respondedAt | ISO\|null |
| declineReason | string\|null |
| staffAcceptedAt, managerConfirmedAt, managerRejectedAt | ISO\|null |
| rejectionReason | string\|null |
| estimatedPayPence | int |
| offerBatchId | uuid\|null |
| shiftId | uuid |
| startsAt, endsAt | **this staff member's assignment window** |
| originalStartsAt, originalEndsAt | **[TEST-DB]** original shift window |
| venueName, roleName | string |
| staffProfileId | uuid |
| staffName | string |
| payRatePence | int (hourly, inferred) |
| venueAddress | string\|null (the shift's snapshot address) |
| shiftNotes | string\|null |
| venuePhotoFileId | uuid\|null |
| offerKind | `standard\|replacement\|standby` **[TEST-DB]** |
| checkInRequired | bool **[TEST-DB]** |
| checkedInAt | ISO\|null **[TEST-DB]** |
| checkInSource | `staff\|qr`\|null **[TEST-DB]** |
| geofenceEnforced | bool **[TEST-DB]** |
| presentation | object, see below |

`presentation`:

| Field | Values / type |
|---|---|
| state | `pending, confirmed, ended, live, clockedOut, complete, expired, declined, rejected, cancelled` |
| homeLabel | `Live Shift, Clocked Out, Complete, Expired, Today's Shift, Next Shift` |
| isToday | bool |
| serverNow | ISO, the trusted clock base |
| nextTransitionAt | ISO\|null |
| clockInAt, clockOutAt | ISO\|null |
| timezone | organisation IANA timezone |

- Flutter does **not** parse `offerKind`, `originalStartsAt` or `originalEndsAt`. iOS may.
- When the server is older than the check-in migration, default `checkInRequired` to `false` and treat `geofenceEnforced` as unknown (`nil`).

### 3.2 Venue Manager reads and sends

All of these are **VM**.

**`all()` paging convention** (Flutter `venue_manager_provider.dart:225-241`): append `page=N&limit=100` from page 1.
- A List response → take it and stop.
- Otherwise read `data` until the count reaches `total`.
- An empty page before `total` → throw "The list changed while loading.".

| Method | Path | Permission | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/offers` | schedule.view | `q, status, staffProfileId, venueId, jobRoleId, shiftDateFrom/To, sentAtFrom/To, sort (sentAt\|shiftDate\|staff\|venue\|status), direction, page, limit` | `{data: OfferSummary[], total}` (offers at the VM's assigned venues) | 400 |
| GET | `/shifts` | schedule.view | `from+to, q, status, venueId, jobRoleId, sort, direction (default asc), page, limit` | `{data: Shift[], total}` | 400 |
| GET | `/shifts/:id` | schedule.view | — | `Shift` | 404 "Shift not found." |
| GET | `/venues` / `/venues/:id` | venue.view | `q, status, type, sort, direction, page, limit` | `{data: Venue[], total}` / `Venue` | 404 |
| GET | `/job-roles` | schedule.view | none (page/limit ignored) | **plain array** `JobRole[]` | — |
| GET | `/shifts/sent` | schedule.view (re-checked) | `view ∈ all\|pending\|accepted\|confirmed\|declined\|expired` (default all), page, limit | `{data: SentShift[], total, view, counts:{all,pending,accepted,confirmed,declined,expired,submitted}}`, ordered `submittedAt DESC` | 403 "Permission required." / "Venue manager required." |
| GET | `/shifts/sent/:id` | schedule.view | — | one `SentShift` (works for expired requests) | 404 "Shift not found." (Flutter: "no longer available") |
| POST | `/shifts/request` | staffing_request.create + workspace | `SubmitShiftRequestDto`, see below | **201** `Shift` (`pending_manager_approval`) | 403; 404 venue/role/staff not in team; 400 selection/time/break/pay; 409 overlap; **409 `STAFF_AVAILABILITY_CONFLICT`**, see below |
| GET | `/staff/venue-directory` | staff.view | `q, status, tag (favourite\|emergency), startAt+endAt (ISO, both needed for `available`), excludeShiftId, page, limit` | `{data:[{id, firstName, lastName, employmentStatus, jobRoleName\|null, isFavourite, isEmergency, available?}], total}`. `available` is present **only** when both window params were sent. | 403; 404 "Directory not found." |
| GET | `/staff/venue-directory/:staffId` | staff.view | — | `{id, firstName, lastName, jobRoleName\|null, employmentType\|null, yearsExperience\|null, skills: string[], availableDays: string[] (Monday…Sunday), preferredShiftTimes\|null, maxHoursPerWeek\|null, isFavourite, isEmergency}`. No contact details or pay. | 404 "Staff member not found." |
| PATCH | `/staff/venue-directory/:staffId/tags` | staff.view | `{favourite?: bool, emergency?: bool}`, at least one. **PATCH only.** | 200 `{isFavourite, isEmergency}` (the server-confirmed state; render it) | 400 "Nothing to update."; 404 |

**`SubmitShiftRequestDto`**
- Required: `venueId`, `jobRoleId`, `startsAt`, `endsAt` (ISO).
- `staffRequired`: int 1..500, ≥ `staffProfileIds.length`.
- `staffProfileIds`: uuid[] 1..500, unique.
- `breakMinutes?`: int ≥0. If omitted: venue default, else 30.
- `staffAssignments?`: `[{staffProfileId, breakMinutes?: int|null, startsAt, endsAt}]` (strict ISO).
- `note?`: ≤2000. **Accepted but silently dropped by the service.** Server bug, see BACKEND_DEPENDENCIES.
- `acknowledgedAvailabilityConflicts?`: `[{staffProfileId, dates:["YYYY-MM-DD"]}]`.
- `payRatePence` → 400.
- **No idempotency key:** a resubmit creates another shift. Flutter treats network errors and 5xx as "uncertain" and does not auto-retry (`send_shift_screen.dart:565-569`).

**`STAFF_AVAILABILITY_CONFLICT`** (409):

```json
{
  "statusCode": 409,
  "code": "STAFF_AVAILABILITY_CONFLICT",
  "message": "…",
  "totalRecipients": 3,
  "conflicts": [
    {
      "staffProfileId": "…",
      "staffName": "…",
      "availableDays": ["…"],
      "conflictDates": [{ "date": "YYYY-MM-DD", "weekday": "…" }]
    }
  ],
  "unknownAvailability": [{ "staffProfileId": "…", "staffName": "…" }]
}
```

To retry, send `acknowledgedAvailabilityConflicts` with every `conflictDates[].date` (`features/venue_manager/availability_conflict.dart:49-77`).

**Schemas**

`Shift` (entity):
- `id, organisationId, venueId, jobRoleId, startsAt, endsAt, defaultStartsAt|null, defaultEndsAt|null, breakMinutes, requiredCount, filledCount, payRatePence, chargeRatePence, notes|null, address|null, status, recurrenceGroupId, createdBy, workspaceId, publishedAt, cancelled*, requestedBy, approved*/declined*, qrVersion, createdAt, updatedAt`.
- Flutter reads: `id, createdBy, address, notes, status, startsAt, endsAt, requiredCount, filledCount, venueId, jobRoleId`.
- **Note:** `chargeRatePence` is exposed to the VM. Flagged in BACKEND_DEPENDENCIES; iOS must not display it.

`SentShift`:

| Field | Type / notes |
|---|---|
| id | uuid |
| status | ShiftStatus |
| requiredCount, filledCount | int |
| startsAt, endsAt | original window |
| submittedAt | ISO |
| venueName, roleName | string |
| actionExpiresAt | end + 5 h |
| actionExpired | bool |
| offerCounts | `{sent,pending,accepted,confirmed,noShow,cancelled,declined,expired,withdrawn,rejected}` |
| statusLabel | server string |
| filters | string[] |
| counters | `{sent,accepted,confirmed: bool}` |

`Venue`:
- `id, organisationId, name, clientName|null, type (hotel|restaurant|warehouse|event|other), address (jsonb; keys line1/city/postcode UNVERIFIED), lat|null, lng|null, geofenceRadiusM (default 200), enforceGeofence, contact (jsonb), instructions/uniform/checkInInstructions/parking/accessNotes|null, breakPaid, defaultBreakMinutes|null, status (active|archived), photoFileId|null, createdBy, workspaceId, createdAt, updatedAt`.

`JobRole`:
- `{id, organisationId, name, defaultRatePence, createdBy, workspaceId, createdAt}`.

**MW only (the VM app must not call these; Flutter's calls are dead code because VM `offer.send` is false):**
- `POST /shifts/:shiftId/offers/bulk` (including `mode:'replacement'`)
- `GET /shifts/:shiftId/replacement-context`
- `GET /shifts/:id/pipeline`
- offer `withdraw/confirm/reject`
- `batches/:id/confirm-all`

They return 403 `APPLICATION_ACCESS_DENIED`.

### 3.3 Status enums (`packages/rab-shared/src`)

| Enum | Values |
|---|---|
| OfferStatus | `pending, staff_accepted, manager_confirmed, manager_rejected, declined, expired, withdrawn` |
| ShiftStatus | `draft, pending_manager_approval, declined, open, offered, partially_filled, fully_filled, confirmed, in_progress, completed, cancelled` |
| ShiftAssignmentStatus | `offered, staff_accepted, confirmed, declined, rejected, withdrawn, cancelled, no_show, completed` (`no_show → completed` is [NOT-REBUILT] shared) |
| AttendanceStatus | `scheduled, clocked_in, on_break, clocked_out, late, missing_clock_out, absent, under_review, approved, disputed` |
| PayrollRecordStatus | `draft, pending_approval, approved, processing, paid, rejected, corrected` |
| OfferKind | `standard, replacement, standby` |
| EmploymentStatus | `pending_compliance, active, inactive, suspended` |

Swift: decode every enum with an `unknown(String)` fallback case. Never crash on a new value.

---

## 4. Venue Manager shift report (`/attendance/report`, VM only)

Source: `modules/attendance/controllers/shift-report.controller.ts`; `services/shift-report.service.ts`, `report-lifecycle.ts`, `report-actions.ts`. Flutter: `features/venue_manager/shift_report.dart`, `venue_manager_provider.dart:430-642`.

**Every seat action returns the full authoritative `ShiftReportDetail`.** Render that response and never patch local state. Scope: a VM can see shifts at its assigned venues; outside scope is 404.

### 4.1 `ShiftReportDetail`

**Top-level fields**

| Field | Type / values |
|---|---|
| shiftId, venueName, roleName | string |
| startsAt, endsAt | ISO |
| reportStatus | `pending\|ready\|finalised` |
| finalisedAt | ISO\|null |
| finalisedBy | uuid\|null |
| finalisedByName | string\|null |
| staff | `ShiftReportStaffRow[]` |
| ready, finalisable | bool |
| reviewsRemaining | int |
| originalFileId, signedFileId | string\|null |
| lifecycle | object, below |
| actions | object, below |
| serverNow | ISO |
| preShiftFile, finalFile | `{fileId, filename}`\|null |
| qrWindow | `{opensAt, closesAt, state: not_open\|open\|closed}` |
| signOff | `{name, breakConfirmed, signedBy\|null, signedAt\|null}`\|null |
| attendancePolicy | `{geofenceEnforced, onBehalfClockOutAllowed (= !geofenceEnforced), onBehalfReasonMinWords: 10}` **[TEST-DB]** |

`lifecycle`:

| Field | Type / values |
|---|---|
| displayStatus | `cancelled, upcoming, waiting_clock_in, in_progress, waiting_clock_out, needs_review, ready_to_finalise, generating, queued, sent, delivery_failed, action_expired` |
| displayLabel | string |
| actionExpiresAt | ISO |
| actionExpired | bool |
| needsAttendanceReview | bool |
| needsAttention | bool |
| deliveryState | `not_finalised, generating, queued, sent, failed, no_recipients` |
| sentAt | ISO\|null |
| historyAt | ISO\|null |
| inCurrent, inHistory | bool |

`actions`:

| Field | Type / values |
|---|---|
| stage | `scheduled, pre_shift, started, finalised` |
| timesheetAvailableAt | ISO (start − 180 min) |
| timesheet | `hidden, preparing, available` |
| finalise | `hidden, disabled, enabled` |
| document | `{kind: pre_shift\|final, fileId, filename}`\|null |
| finalDocumentPending | bool |
| preShiftDocument | same shape\|null |

**`ShiftReportStaffRow`.** Only seats in `confirmed/completed/no_show` are included, ordered by name.

| Field | Type / values |
|---|---|
| staffProfileId | string |
| avatarFileId | string\|null |
| staffName, roleName | string |
| assignmentStatus | `confirmed\|completed\|no_show` |
| attendanceId | string\|null |
| attendanceStatus | string\|null |
| clockInAt, clockOutAt | ISO\|null |
| breakMinutes | int\|null |
| scheduledBreakMinutes | int |
| scheduledStart, scheduledEnd | ISO |
| workedMinutes | int\|null |
| earnedPence | int\|null |
| locationVerified | bool |
| clockOutMethod | string\|null |
| corrected, performanceReviewed, attendanceReviewed | bool |
| attendanceReviewedAt | ISO\|null |
| attendanceReviewedByName | string\|null |
| assignmentBreakMinutes | extra raw key |
| manuallyEntered | bool **[NOT-REBUILT]** |
| attendanceVersion | opaque\|null **[NOT-REBUILT]** |
| noShowConfirmed | bool **[NOT-REBUILT]** |
| noShowConfirmableAt | ISO **[NOT-REBUILT]**; scheduled start + 30 min |
| checkInRequired | bool **[TEST-DB]** |
| checkedInAt | ISO\|null **[TEST-DB]** |
| checkInSource | **[TEST-DB]** |
| checkInLocationVerified | **[TEST-DB]** |
| clockInMethod | **[TEST-DB]** |
| clockInByName, clockInReason, clockOutByName, clockOutReason | **[TEST-DB]** |

Seat states:
- **Provisional no-show** = `assignmentStatus == no_show` **and** `attendanceReviewed == false`. Show it as "Attendance missing · Needs review", **not** as a no-show.
- **Confirmed no-show** = `noShowConfirmed == true`.

`ShiftReportSummary` (list row): `{shiftId, venueName, roleName, startsAt, endsAt, shiftStatus, requiredCount, filledCount, staffCount, clockedOut, noShows (includes provisional), reportStatus, lifecycle}`.

### 4.2 Routes (all `venue_manager_app`)

| Method | Path | Permission | Request | Response | Errors | Idempotency | Deploy |
|---|---|---|---|---|---|---|---|
| GET | `/attendance/report/shifts?bucket=current\|history&page=&limit=` | report.view | `bucket` **required** | `{data: ShiftReportSummary[], total, serverNow}`. Default limit **50**. Current bucket: needs-attention first, then by start. History: by end, descending. | 400 bad bucket | read | [DEV] |
| GET | `/attendance/report/shift/:shiftId` | report.view | — | `ShiftReportDetail` | 404 "Shift not found." | read | [DEV] |
| PATCH | `/attendance/report/shift/:shiftId/finalise` | report.export | `{signedOffName (2..120), breakConfirmed: true}`, both or neither. Flutter sends both (`sign_off_sheet.dart`). | `ShiftReportDetail` | 400 sign-off; 409 not started / no staff / waiting clock-outs / N reviews remaining / still clocked in; 409 payroll pay mismatch | **Idempotent** (already finalised = 200, no change) | [DEV] |
| POST | `…/shift/:shiftId/staff/:staffProfileId/attendance-review` | attendance.edit | no body | `ShiftReportDetail` | 409 finalised / not started / still clocked in / clock-out missing / "No attendance has been recorded yet. Record the attendance, or confirm the no-show." | idempotent | [DEV] |
| POST | `…/staff/:staffProfileId/record-attendance` | attendance.edit | `{clockInAt?, clockOutAt? (ISO with offset), breakMinutes? 0..1440, reasonCode: forgot_clock_in\|forgot_clock_out\|app_issue\|venue_issue\|other, reasonNote? (≤500; ≥10 chars when other), expectedVersion? (last attendanceVersion, or null = "no attendance seen")}` | `ShiftReportDetail` | 400 reason too short; 400 **`INVALID_ATTENDANCE_TIMES`** (both times needed when there is no row; not future; in ≥ start − 15 min; ≤ end + 120 min; out > in; break < span); 409 finalised / cancelled / **version mismatch** "…changed by someone else. Refresh…" / just recorded / "This no-show has been confirmed. Reopen it before recording attendance." / overlap | an identical resubmit is a no-op | **[NOT-REBUILT]** |
| POST | `…/staff/:staffProfileId/confirm-no-show` | attendance.edit | no body | `ShiftReportDetail` | 409 finalised / attendance exists / "A no-show can be confirmed 30 minutes after the scheduled start." | idempotent | **[NOT-REBUILT]** |
| POST | `…/staff/:staffProfileId/reopen-no-show` | attendance.edit | `{reason: 10..500 chars}` | `ShiftReportDetail` | 400; 409 finalised / "Only a confirmed no-show can be reopened." / **`SEAT_TAKEN_BY_REPLACEMENT`** | — | **[NOT-REBUILT]** (+ vacancy rule [TEST-DB]) |
| POST | `…/staff/:staffProfileId/clock-in-on-behalf` | attendance.edit | `{reason}` (≤1000 chars, **≥10 words**; Flutter's `reasonWordCount` mirrors the server rule) | `ShiftReportDetail` | 400 `REASON_TOO_SHORT`; 409 finalised, `ALREADY_CLOCKED_IN`, `ATTENDANCE_FLAGGED_MISSING`, `SHIFT_NOT_CONFIRMED`, `SHIFT_NOT_OPEN`, `CLOCK_IN_TOO_EARLY`, `CLOCK_WINDOW_CLOSED`, **`STAFF_NOT_CHECKED_IN`**, `GEOFENCE_MISCONFIGURED`, **`PRESENCE_NOT_VERIFIED`** (enforcing venue, unverified check-in) | not replay-safe (a repeat gives `ALREADY_CLOCKED_IN`) | **[TEST-DB]** |
| POST | `…/staff/:staffProfileId/clock-out-on-behalf` | attendance.edit | `{reason}` (≥10 words) | `ShiftReportDetail` | 400 `REASON_TOO_SHORT`; 409 finalised, `NOT_CLOCKED_IN`, **`PRESENCE_EVIDENCE_REQUIRED`** (refused at every geofence-enforcing venue; send the manager to Record attendance instead), `CLOCK_WINDOW_CLOSED` | not replay-safe | **[TEST-DB]** |
| POST | `/attendance/:attendanceId/correct` | attendance.edit | `{field: clockInAt\|clockOutAt\|breakMinutes, newValue: string, reason: ≥10 chars}` | **201** `AttendanceSummary` (**not** the report; reload the report afterwards) | 404; 409 finalised / still on shift / add clock-out first; 400 invalid time | an identical value is a no-op | [DEV] (legacy; no QR-window bounds) |
| GET | `…/shift/:shiftId/reviews/:staffProfileId` | review.create | — | `{review: StaffReview\|null, editable}` | 404 | read | [DEV] |
| PUT | `…/shift/:shiftId/reviews/:staffProfileId` | review.create | `{grooming, attitude, skills, attendance, timeKeeping: int 1..5 (all required), feedback? ≤2000}` | `StaffReview {shiftId, staffProfileId, grooming, attitude, skills, attendance, timeKeeping, feedback\|null, reviewerUserId, reviewerName, createdAt, updatedAt}` | 409 after finalisation | upsert | [DEV] |

`/staff/:staffProfileId/reviews` (aggregates) is **MW only**.

### 4.3 Documents and QR sheet

- There are no PDF routes. The worker renders PDFs into `stored_file`. The report exposes `actions.document`, `actions.preShiftDocument`, `preShiftFile` and `finalFile` (only `AVAILABLE` files).
- Fetch with `GET /files/:fileId/download` (§8).
- **`report_document_screen.dart`** shows "preparing" while `timesheet == preparing` or `finalDocumentPending`.
- **`staff_qr_screen.dart`** renders the **pre-shift attendance sheet PDF** (`actions.preShiftDocument`), which contains a 128 px shift QR. Its states:
  - closed when `reportStatus == finalised` or `qrWindow.state == closed`
  - not-yet when `actions.stage == scheduled` (shows `timesheetAvailableAt`)
  - otherwise preparing, with Retry
- Swift: render with PDFKit and allow zoom.

---

## 5. Staff payroll (`/payroll/me`, Staff) [DEV]

Source: `modules/payroll/controllers/payroll.controller.ts:168-190` (`StaffShiftStatementsController`); `payroll.service.ts:144-200, 422-468`; `payroll-run.service.ts:20-55, 277-330`. Flutter: `features/payslips/payslips_screen.dart:53-69`, `payroll_documents.dart`. The console `PayrollController` is MW only.

| Method | Path | Permission | Request | Response | Pagination |
|---|---|---|---|---|---|
| GET | `/payroll/me/statements` | payslip.view_own + workspace | `page?, limit?` (default **50**, max 1000). Flutter: `?limit=100` and ignores `total`. | `{data: StaffShiftStatement[], total}`. Only the caller's own approved/processing/paid records, ordered `approved_at DESC`. No staff profile → `{data:[], total:0}`. | page/limit |
| GET | `/payroll/me/payslips` | payslip.view_own + workspace | — | `{data: StaffPayslipEntry[], unallocated:{shiftCount, grossPence}}`, sorted by `payday` desc | **none** |

**`StaffShiftStatement`**

| Field | Type / values |
|---|---|
| payrollRecordId | string |
| status | `approved\|processing\|paid` |
| attendanceId, shiftId | string |
| venueName, roleName | string |
| startsAt, endsAt | ISO |
| workedMinutes, payRatePence, amountPence | int (non-null) |
| approvedAt | ISO |
| payrollPeriod | `{id, start:"YYYY-MM-DD", end:"YYYY-MM-DD"}`\|null |
| payday | `"YYYY-MM-DD"`\|null |
| allocationStatus | `allocated\|carried_forward\|unallocated` |
| statement | `{state: processing\|available\|failed, fileId\|null, filename\|null, generatedAt\|null, notifiedAt\|null}`; `fileId` is set only when `available` |

**`StaffPayslipEntry`**

| Field | Type / values |
|---|---|
| payslipId | string\|null |
| runId | string\|null |
| period | `{id, start, end}` (date-only) |
| payday | `"YYYY-MM-DD"` |
| status | `upcoming\|processing\|available\|paid` |
| shiftCount | int |
| grossPence | int |
| netPence | int\|null |
| netSource | `"provider_document"`\|null |
| document | `{fileId, filename\|null, version, uploadedAt}`\|null |
| paidAt | ISO\|null |

Notes:
- Flutter ignores `unallocated`, `allocationStatus`, `netSource` and `document.version`. iOS should at least not break on them.
- Documents download through `/files/:fileId/download` (`ShiftStatementFilePolicy` / `PayslipFilePolicy`) and are shown in `PayrollDocumentScreen` (PDF; `%PDF-` magic check).

---

## 6. Push registration (`/push/devices`, both apps)

Source: `engine/core-modules/push/**`; Flutter `core/push/push_registration_service.dart`, `push_device_store.dart`.

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| POST | `/push/devices` | `{deviceId: string 1..255, platform: "ios"\|"android", pushToken: string 1..4096, appVersion?: ≤64}` | **201** `{id}`. Upserts on `(userId, deviceId)`; the token is stored encrypted; other users' rows with the same deviceId are deactivated. | 400 (unknown fields) |
| POST | `/push/devices/:deviceId/deactivate` | — | **204**, idempotent | **404 if `deviceId` is not a UUID** (interceptor) |
| POST | `/push/devices/deactivate-all` | — | **204** | |

- **iOS token:** send the **raw APNs device token** (hex of `didRegisterForRemoteNotificationsWithDeviceToken`) with `platform:"ios"`. **Do not use Firebase / an FCM token on iOS.** With `PUSH_PROVIDER=REAL` the server routes `ios` to its **direct APNs driver** (`drivers/apns.driver.ts`: HTTP/2 to `api.push.apple.com` or the sandbox, ES256 provider JWT from `APNS_AUTH_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID`, `apns-topic = APNS_BUNDLE_ID`). An FCM token sent to APNs would fail.
- **deviceId:** use `UUID().uuidString`, persisted in Keychain per install. Flutter's 32-hex id makes deactivate 404 (bug, see BACKEND_DEPENDENCIES).
- Re-register when the token changes and on each authenticated cold start.
- Deactivate **before** `/auth/logout`.
- **Payload:** `{"aps":{"alert":{"title":"Crewflow","body":"You have a new notification. Tap to view."},"mutable-content":1},"notificationId":"<uuid>","type":"<notification type>"}`. There is no business data, sound or badge. On receipt or tap, refetch `/notifications` (Flutter never writes push content into state; there is no per-type deep link yet).
- **Server switches:** delivery requires `PUSH_ENABLED=true` (default false), `PUSH_PROVIDER=REAL` (default FAKE) and an `APNS_ENVIRONMENT` that matches the build (`sandbox` for dev-signed, `production` for TestFlight and the App Store).

---

## 7. Realtime SSE (`GET /realtime/stream`, both apps)

Source: `engine/core-modules/realtime/realtime-gateway.controller.ts`, `realtime-envelope.ts`; Flutter `core/realtime/realtime_connection_service.dart`, `realtime_envelope.dart`.

**Request**
- Headers: `Authorization: Bearer <access>`, `Accept: text/event-stream`, `Cache-Control: no-cache`.
- **Never put the token in the URL.** There is no ticket or query auth.

**Response**
- 200 `text/event-stream` (`X-Accel-Buffering: no`).
- **204 when `REALTIME_ENABLED=false` (the default).** Treat it as "realtime off", rely on polling, and do not hot-loop.

**Frame format**

```
event: <type>
id: <eventId>
data: {"version":1,"eventId":"<uuid>","type":"offer.sent","organisationId":"<uuid>","workspaceId":null|"<uuid>","targetUserId":"<uuid>","entityId":"<uuid>","occurredAt":"ISO"}
```

There is no business payload.

**Envelope validation** (`realtime_envelope.dart`)
- Accept only `version == 1`.
- Accept only a known `type`: `offer.sent`, `offer.accepted`, `offer.confirmed` (the server also has the web-only `navigation_layout.saved`; ignore it).
- Every id must be a UUID.
- `targetUserId` must be non-null.
- `occurredAt` must parse.
- `data` must be ≤8 KB, and the parser buffer ≤64 KB.
- Drop invalid frames silently.

**Dedup:** a FIFO of the last 200 `eventId`s.

**Routing** (refetch only; never apply envelope data to state)
- `offer.sent` / `offer.confirmed` → reload `/offers/mine` (Staff).
- `offer.accepted` → VM refresh.

**Stream lifetime**
- **No heartbeat frames are written.**
- **No replay:** `Last-Event-ID` is ignored.
- At most 3 connections per user. An extra connection completes immediately.
- The server ends the stream when the bearer JWT `exp` passes (≈15 min), when the session is revoked or idle, when the security vector changes, or on any heartbeat error.

**Client behaviour (mirror)**
- Reconnect with exponential backoff, 1 s → 30 s, with 50–100 % jitter.
- On 401/403 at connect, call `GET /auth/me` to trigger the single-flight refresh. If that fails, stop (no infinite retry).
- Fence each connection with the session generation captured at connect.
- Disconnect in the background; on foreground, reconnect **and reconcile** (offers, `/me/active`, `/me/history`, VM refresh).
- Swift: `URLSession` `bytes(for:)` async line reader.

---

## 8. Files

Source: `engine/core-modules/storage/files.controller.ts` (`@MobileApplication()` for both apps); Flutter `api_client.dart:199-262`, `core/widgets/venue_photo.dart`.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/files/:fileId` | **Always streams bytes and never redirects.** Inline images (venue photo, avatar). Headers: `Content-Type`, `Content-Disposition`, `Cache-Control: private, max-age=3600` (images) or `no-store` (PDFs), `nosniff`, a CSP sandbox. 240/min. |
| GET | `/files/:fileId/download` | Documents (PDF). **LOCAL driver:** 200 bytes, `attachment`. **S3 driver: 302 `Location: <presigned URL>`** (TTL `S3_SIGNED_URL_TTL_SECONDS`, default 120 s). **Follow the redirect manually with NO `Authorization` header.** The bearer must never reach the storage host and the token is never put in a URL. Resolve `Location` relative to the base URL. One refresh-and-retry on 401. Read the filename from `Content-Disposition` (`filename*=UTF-8''` first). Verify the `%PDF-` magic before showing or saving. Swift: a `URLSessionTaskDelegate` `willPerformHTTPRedirection` that returns `nil`, then a plain GET. 60/min. |
| POST | `/files/previews` | `{fileIds: uuid[1..32]}` → `{previews:{id: dataURL}, expiresInSeconds}` (PROFILE_IMAGE only). Not used by Flutter. |
| POST | `/files/upload-intent`, `/files/:fileId/complete` | Direct S3 upload of `PROFILE_IMAGE` (501 `NOT_SUPPORTED` on LOCAL). Not used by Flutter. |

**Every denial is 404 "File not found."**, never 403. A venue photo returns 404 for a staff member **without live work** at that venue (completed-shift history keeps a `venuePhotoFileId` whose bytes return 404, by design). Show the placeholder; this is not an error.

**Avatar upload (mobile-allowed, not used by Flutter)**
- `POST /profile/avatar`: multipart, field **`file`**, exactly one part, ≤10 MB, PNG/JPEG/WebP checked by magic bytes. Returns 201 `{id, email, firstName, lastName, jobTitle, avatarKey}`.
- `DELETE /profile/avatar`.
- Report rows carry `avatarFileId`.

---

## 9. Notifications (both apps)

Source: `modules/notification/controllers/notification.controller.ts`; Flutter `features/notifications/notifications_provider.dart`.

| Method | Path | Response |
|---|---|---|
| GET | `/notifications` | 200 **plain array, the 50 newest, no pagination**: `[{id, organisationId, userId, type, title, message, relatedEntityType\|null, relatedEntityId\|null, channelState (object), readAt\|null, createdAt}]` |
| GET | `/notifications/unread-count` | 200 `{count}` |
| POST | `/notifications/:id/read` | **204**; 404 "Notification not found." |
| POST | `/notifications/read-all` | **204** |

Notification `type` values are listed in `packages/rab-shared/src/types/notification-type.ts`. Examples: `offer_sent`, `offer_confirmed`, `shift_reminder_2h`, `shift_cancelled`, `clock_in_window_open`, `payslip_available`, `shift_statement_ready`. Flutter's mark-read is best-effort and silent on failure.

---

## 10. Error-code catalogue (attendance and report)

| code | HTTP | Extra fields | Thrown by |
|---|---|---|---|
| CLOCK_IN_TOO_EARLY | 409 | `shiftStart`, `availableAt` | clock-in, clock-in-on-behalf |
| CLOCK_WINDOW_CLOSED | 409 | — | clock-in, on-behalf punches |
| CHECK_IN_TOO_EARLY | 409 | `shiftStart`, `availableAt` | check-in |
| CHECK_IN_WINDOW_CLOSED | 409 | — | check-in |
| CHECK_IN_REQUIRED | 409 | — | clock-in |
| LOCATION_REQUIRED | 409 | — | check-in, clock-in, clock-out, geofence-exit |
| LOCATION_ACCURACY_TOO_LOW | 409 | — | same |
| LOCATION_STALE | 409 | — | same |
| OUTSIDE_GEOFENCE | 409 | `venueName` | check-in, clock-in, clock-out (was `OUTSIDE_VENUE`) |
| GEOFENCE_MISCONFIGURED | 409 | — | strict punches, clock-in-on-behalf |
| INVALID_QR | 409 | `reason: expired\|invalid\|shift_mismatch\|venue_mismatch` | check-in (when a QR is sent), clock-in, clock-out |
| ATTENDANCE_FLAGGED_MISSING | 409 | — | check-in, clock-in, clock-in-on-behalf |
| SHIFT_NOT_CONFIRMED / SHIFT_NOT_OPEN | 409 | — | **check-in and clock-in-on-behalf only** (clock-in sends the same text with no code) |
| ALREADY_CLOCKED_IN | 409 | — | check-in, clock-in, clock-in-on-behalf |
| NOT_CLOCKED_IN | 409 | — | clock-out-on-behalf |
| STAFF_NOT_CHECKED_IN | 409 | — | clock-in-on-behalf |
| PRESENCE_NOT_VERIFIED | 409 | — | clock-in-on-behalf (enforcing venue) |
| PRESENCE_EVIDENCE_REQUIRED | 409 | — | clock-out-on-behalf (enforcing venue) |
| REASON_TOO_SHORT | 400 | — | on-behalf punches |
| INVALID_ATTENDANCE_TIMES | 400 | — | record-attendance |
| SEAT_TAKEN_BY_REPLACEMENT | 409 | — | reopen-no-show |
| STAFF_AVAILABILITY_CONFLICT | 409 | `conflicts`, `unknownAvailability`, `totalRecipients` | `/shifts/request` |
| APPLICATION_ROUTE_DENIED / APPLICATION_ACCESS_DENIED | 403 | — | JwtAuthGuard |
| AUTH_UNAVAILABLE / RATE_LIMIT_UNAVAILABLE | 503 | — | guards (do not log out) |
| AMBIGUOUS_ACCOUNTS | 401 | — | login |
| JSON_REQUIRED | 415 | — | login |

Text: Flutter maps codes code-first for staff and server-text-first for managers (`core/api/attendance_messages.dart`). Port that file's strings verbatim.
