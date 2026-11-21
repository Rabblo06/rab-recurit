# Security notes — Crewflow iPhone core

Scope: `packages/rab-iphone` core (networking, storage, session, biometrics,
logging, transport). Status: source implemented, **not compiled or tested**.
Server-side controls (guards, RLS, permissions) are unchanged and remain the
authority; nothing here grants access.

## 1. Secret storage (Keychain)

| Item | Keychain service | Key | Lifetime |
|---|---|---|---|
| Access JWT | `<bundle id>.session` | `rab.accessToken` | session |
| Refresh token | `<bundle id>.session` | `rab.refreshToken` | session (written **before** the access token, CF-19) |
| Session owner user id | `<bundle id>.session` | `rab.sessionUserId` | session |
| Remembered account `{userId,email}` | `<bundle id>.device` | `rab.biometric.rememberedAccount` | survives logout |
| Biometric binding | `<bundle id>.device` | `rab.biometric.enabledUserId`, `rab.biometric.confirmedAt` | survives logout |
| Last password sign-in (90-day anchor) | `<bundle id>.device` | `rab.biometric.lastFullAuthenticationAt` | survives logout |
| Push device id (UUID) | `<bundle id>.device` | `rab.push.deviceId`, `rab.push.registeredUserId` | install |

- Class `kSecClassGenericPassword`, accessibility
  **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`**: readable after the
  first unlock since boot (so background work can refresh), **never migrated
  to another device**. `kSecAttrSynchronizable = false`: never in iCloud
  Keychain. No access group: no keychain sharing with other apps.
- Backups / device transfer: `ThisDeviceOnly` items are excluded from
  restores to a different device and from Quick Start device-to-device
  migration; a new phone always needs a fresh sign-in. An encrypted backup
  restored to the *same* device restores them.
- Uninstall: the Keychain survives app deletion. `FreshInstallGuard` wipes
  both services on the first launch of a new install (marker in
  UserDefaults, which *is* deleted on uninstall), so an old session never
  resumes silently.
- Read failures (including `errSecInteractionNotAllowed` before first
  unlock) read as "no session" → sign-in required (fail closed).
- **No password and no biometric data is ever stored.** UserDefaults holds
  only the non-secret install marker.

## 2. Token lifecycle

- Login: `POST /auth/login {email, password}` with `X-Client-Platform:
  mobile`; no `applicationTarget`, no `organisationId` (the server derives
  both). Response tokens are stored, then `GET /auth/me` decides identity
  and routing; `/auth/capabilities` gives display hints only.
- Refresh tokens rotate on every use and reuse revokes the whole family:
  `SessionGate` makes refresh **single-flight**, skips a refresh when another
  caller already rotated the token, and persists refresh-before-access.
- Every logout/account switch bumps a **generation**. A refresh that lands
  afterwards is discarded (never written); a request dispatched under the old
  generation is never replayed with the new identity's token; any response
  arriving after the switch is dropped (`APIError.sessionChanged`).
- At most one replay after a 401 (no loops). `/auth/login`, `/auth/refresh`,
  `/auth/forgot-password`, `/auth/set-password` never trigger a refresh.
- Session ends locally only when the server rejects the refresh (401/403
  from `/auth/refresh`) or `/auth/me` returns 401 after a failed refresh.
  **403 `APPLICATION_ROUTE_DENIED`/`APPLICATION_ACCESS_DENIED` and 503
  `AUTH_UNAVAILABLE` never log anyone out**; timeouts never touch the
  session. (Deliberate tightening vs Flutter, which also cleared tokens on a
  403 from `/auth/me` at launch.)
- Logout: bump epoch → UI to sign-in → cancel in-flight requests →
  deactivate the push device if registered (before logout; the server does
  not do it) → best-effort `POST /auth/logout {refreshToken}` (10 s) →
  wipe tokens, reset the URL session, delete per-session temp files, clear
  toasts. Remembered account and biometric trust are kept (Flutter parity).
- Server lifetimes (not enforced client-side): mobile family 90 days
  absolute, 7 days idle; access JWT 15 min. Polling should use
  `RequestOptions.backgroundPoll` so it does not keep an idle session alive.

## 3. Biometric semantics

- `LocalAuthentication`, `.deviceOwnerAuthenticationWithBiometrics`
  (biometric only, no passcode fallback). A **local presence gate only**:
  success merely allows the app to *attempt* `GET /auth/me`; the server's
  answer decides. A biometric never unlocks a stored password (none exists).
- Cold-launch lock: "unlocked" lives only in memory; every process start is
  locked. With a valid binding → `biometricLocked`; otherwise password.
  A stored session without biometrics still requires the password
  (`reauthRequired`: "a restored server identity is not proof of presence").
- Binding valid only if `enabledUserId == sessionUserId == rememberedUserId`,
  `confirmedAt` is not in the future, and the last **password** sign-in is
  < 90 days old. Re-confirming biometrics never extends the 90-day deadline
  (MOB-02); enabling is refused once it has passed. Deadline enforced on
  scene activation and by one timer (MOB-01).
- After unlock, `/auth/me.id` must equal the remembered and session user,
  otherwise the session is wiped.
- Not re-locked on backgrounding (Flutter parity). Owner decision if wanted.

## 4. Transport and ATS

- Release: HTTPS only. The app refuses to start with a missing, placeholder
  (`*.invalid`) or non-HTTPS `API_BASE_URL`, and a build phase fails a
  Release build in the same cases. No ATS exception in Release.
- Debug only: `NSAllowsLocalNetworking` is added to the *built* Info.plist by
  a build phase for the Debug configuration (LAN dev servers). The committed
  Info.plist has no ATS keys.
- URL session: ephemeral, no URL cache, no cookie storage, no credential
  storage. Automatic redirects are refused for every request (an
  `Authorization` header must never be replayed to another host).
- File downloads: `GET /files/:id/download` → on 302 the presigned URL is
  fetched with **no headers at all**; Release refuses a non-HTTPS storage
  URL. PDFs are checked for the `%PDF-` magic before use (`isPDF`).
  Per-session files go to `tmp/crewflow-session/` with complete file
  protection and are deleted on logout.
- `rab://login` deep link (CF-37) only brings the app forward; it never signs
  out and never discards a stored session. iOS cannot guarantee scheme
  ownership: if the Flutter app is installed on the same device both claim
  `rab://`. The link carries no token, so the impact is a wrong app opening.
- No certificate pinning (not present in Flutter either; owner decision).

## 5. Logging rules

Never log: access/refresh tokens, `Authorization` headers, passwords,
request/response bodies, presigned storage URLs (their query string is a
credential), document/PDF bytes, push tokens. Paths may contain record ids
and are logged with `privacy: .private`; status codes, durations, methods and
error codes are public. Decoding failures log only the type name.

## 6. Two-factor authentication (account security step 1, 2026-10-25)

Source only, NOT compiled or run. Server contract: `docs/account-security/STEP1_REPORT.md`.

- Every request sends `X-Client-Capabilities: mfa-verify` (with `X-Client-Platform: mobile`). Client-asserted: it can
  only enable the challenge path; omitting it never skips the factor.
- `409 SECOND_FACTOR_REQUIRED` → phase `.secondFactor`. **Nothing is written** to the Keychain or UserDefaults: no
  token, no session owner, no remembered account, no 90-day anchor. The challenge token lives in memory only, is never
  logged and is redacted from `description`/`debugDescription`/`Mirror`. Tokens are stored only from the verify
  response (the same `finishSignIn` path as a password sign-in); if `/auth/me` then fails, the issued session is wiped.
- Verify, enrolment confirm, regenerate and disable are **never auto-retried** (a code is single-use and every attempt
  is counted server-side). On an uncertain outcome the person decides; enrolment confirm reloads `GET /auth/mfa` and,
  when 2FA turned on, says the codes could not be shown and offers a new set.
- 401 `MFA_CODE_INVALID` / `MFA_CHALLENGE_EXPIRED` / `MFA_CHALLENGE_EXHAUSTED` are handler answers: mapped to
  `.http(401)` (not a session rejection), never trigger a refresh and are never replayed. The self-service
  `/auth/mfa*` routes refresh an expired access token once like any guarded route; `/auth/mfa/challenge/*` never do.
  A wrong FIRST code at enrolment confirm is matched by `code: MFA_CODE_INVALID` whether the server answers 401 (today)
  or 400 (owner-approved change); neither is a session expiry, neither refreshes or replays.
- Attempts and cooldowns are shown only from the server (`attemptsRemaining`, `Retry-After`); the challenge TTL is
  not sent, so no number is shown.
- `otpauth://` links are opened only when they parse as `otpauth://totp/…` with a secret; the URI and setup key are
  never logged. The QR (`qrDataUrl`) is not decoded on the phone.
- Recovery codes and the setup key: copy goes to the local pasteboard only (`.localOnly`, no Universal Clipboard) and
  expires after 5 minutes; Share uses the system share sheet (owner decision: copy and share allowed). A privacy cover
  replaces the setup/codes screens whenever the scene is not active (app-switcher snapshot) and while
  `UIScreen.isCaptured` (recording, mirroring, AirPlay; `UIScreen.capturedDidChangeNotification`). iOS cannot block a
  screenshot; `userDidTakeScreenshotNotification` shows a notice on the codes screen.
- The update-required screen offers a store button only for an allowlisted HTTPS `apps.apple.com` URL from the server.
- Debug-only canned backend `TwoFactorUITestStub` (`#if DEBUG`, needs `-CrewflowUITesting` + `-CrewflowTwoFactorStub`).

## 7. Offline punch queue (M4 Lane B, NOT enabled anywhere)

Design: `docs/plans/m4-offline/DESIGN.md` (owner-approved 2026-11-21). **HARD RULE:** offline clocking stays off
everywhere until M5 payroll adjustments exist and `POST /attendance/me/sync` has been pen-tested. Code:
`Crewflow/Features/Staff/OfflineSync/`.

- **Off by construction.** An action is saved on the phone only when ALL hold: the build switch Info.plist
  `CrewflowOfflineAttendance` = YES (the key is in no configuration, so it is off in every build); a device-key signer
  exists (none does: `POST /attendance/me/device-key` is not on the server, and `StaffOfflineAttendance.live` passes
  `signer: nil`); the last `/attendance/me/active` said `offline.enabled: true` and carried an `offlineTicket`; and the
  ticket arrived in this boot less than 16 h ago. Anything else (an older server without the fields, a reboot, a
  malformed ticket, a ticket whose fetch took > 10 s) leaves it off.
- **Storage.** Per user, Keychain items through the existing `SecureStore` in `<bundle id>.device`
  (`AfterFirstUnlockThisDeviceOnly`, not synchronizable): `rab.offline.queue.<userId>` (the queue, JSON),
  `rab.offline.ticket.<userId>` (the ticket + the boot reading when it arrived + its `serverNow`),
  `rab.offline.installId`, `rab.offline.seq.<installId>`. Never UserDefaults or a plain file. Another user on the same
  phone never reads, sends or overwrites the queue (keyed by user id; the server would also refuse it: ticket subject).
  `FreshInstallGuard` wipes it on reinstall. Reads are three-way (`SecureStore.read`: value / absent / failed with the
  OSStatus): a FAILED Keychain read (e.g. before first unlock) is "unreadable", never an empty queue, so it is never
  overwritten or discarded, and is re-checked right before every write; a failed or corrupt counter / install-id read
  refuses capture (clientSeq is never numbered from a guess). An unreadable queue blocks capture and sign-out asks first.
- **Limits (D5, §3.4).** 30 entries and 48 KB per user; no capture more than 16 h after the ticket; an entry captured
  more than 72 h ago (server-anchored clock, never the wall clock) is never sent and stays visible until dismissed.
- **Entry (§3.2) and time.** Exactly the DESIGN members, nothing else (forbidNonWhitelisted). Never
  `organisationId`, `workspaceId`, `staffProfileId`, `status`, `clockInAt`/`clockOutAt` or money. Time evidence is the
  boot clock only: `CLOCK_MONOTONIC_RAW` (counts sleep, unaffected by time/frequency adjustment) + sysctl `kern.bootsessionuuid`, never
  `ProcessInfo.systemUptime` (stops in sleep: earlier punch, more pay). `deviceWallClockAt` is diagnostics for the
  server's skew flags. The phone never computes paid time; the server anchors and bounds every time (§4).
- **Signature.** Each entry is signed over its RFC 8785 canonical JSON (every member except `sig`;
  `OfflineCanonicalJSON`, tested against the RFC number samples). The signer is a protocol only (`OfflineEntrySigning`):
  the Secure Enclave P-256 key and its registration wait for the server's device-key route.
- **Sync (`OfflineSyncEngine`, `POST /attendance/me/sync`, DESIGN §3.5 / §7).** `clientSeq` order, at most 25 per
  request, one request at a time. Per-item outcomes by idempotency key: `applied` / `duplicate` / `replayed` delete the
  entry; `rejected` keeps it visible with the server's code (only `^[A-Z][A-Z_]{2,48}$` is stored; the words shown come
  from a client table, never server text); a missing or unknown outcome leaves it pending (never assumed received)
  and ends the run, so no later batch overtakes an unanswered earlier punch. The signed-in user must equal the queue's
  owner before every request, and the request itself is bound to that user id (`RequestOptions.requiredSessionUserId`,
  checked where the bearer token is read, so an account switch cannot slip in between); `Retry-After` is capped at 15 min. Size limits apply to appends only (recording an
  outcome can never be refused for size). A
  whole-batch 400/413/422 is resent one entry at a time and the refused one is parked as undeliverable. 429 waits for
  `Retry-After` whatever the trigger; network, timeout, 5xx, 403, 404 and undecodable answers back off 1 s to 5 min
  (Send now skips the backoff, never `Retry-After`). A timeout is an uncertain outcome: the entry is kept and resent
  with the same key (the server answers `replayed`). A ticket in a sync answer only renews an open gate, never opens a
  closed one, and obeys the same 10 s rule. Never auto-retried by the transport (`RetryPolicy.never`).
- **Clock screen wiring (`StaffStore`, `StaffClockFlow`, `StaffClockScreen`, Profile).** Online first, always. Only
  while the gate is open does a check-in / clock-in / clock-out carry an `Idempotency-Key` (UUID v4 made at the tap);
  if that request gets no answer (offline) or times out after sending (uncertain), the action is saved with the SAME key
  so the server applies it at most once (D17). Only a genuine no-response failure is saved (`APIError.isNoResponse`:
  connection, DNS, TLS, connection lost, or the client's own timeout); any HTTP answer is not, and a server or proxy
  408 now maps to `.http(408)`, kept apart from the client timeout (still an uncertain outcome that reloads, never a
  resend). While saved actions are waiting, a new punch first sends them and, if any still wait, is saved behind them
  (gate open) or refused (gate shut): it is never sent online ahead of them. With the gate shut
  (every build today) requests carry no header and the existing uncertain-outcome handling is unchanged. Nothing is
  optimistic: no attendance is shown until the server answers; a saved clock-in replaces the running timer with fixed
  text "Clocked in 09:02, saved on this phone, not yet confirmed" (D10; the time is the server-anchored estimate, never
  the wall clock). A clock-out after a saved clock-in first sends what is saved; it becomes an ordinary online clock-out
  if the clock-in reaches the server, otherwise it is saved too. Sending is triggered by every successful
  `/attendance/me/active` read (30 s reconcile, resume, refresh) and "Send now"; afterwards the server state is re-read.
  `RequestOptions.headers` can never set or replace `Authorization`, `Content-Type`, `Accept`, `Cookie`, `Host`,
  `X-Client-*` or `X-Crewflow-Background`.
- **Sign-out (D18).** While any action is unsent (pending, too old, undeliverable, or an unreadable queue), Log out
  asks first: Send now, Discard and log out (explicit; discarded actions are never sent and the manager is not told),
  or Cancel. An unreadable stored queue is never discarded (not even explicitly): the dialog offers "Log out and keep
  them" instead, and the item stays under the user's id. A forced sign-out (session ended by the server) does not discard: the queue stays in the Keychain under
  that user's id and is sent after the same user signs in again (or ages out after 72 h).
- **Integrity signal.** `rootedSignal` is a weak client-asserted jailbreak path check, a flag on the receipt only (D11).
- **Residual.** A jailbroken, hooked app can sign lies within the server's bounds (DESIGN §2 trade-off: schedule clamp,
  no untrusted clock-out, manager review). Keychain `ThisDeviceOnly` items are restored by an encrypted backup to the
  SAME device, so a restore can bring back an old queue; the server refuses it after 72 h (`SYNC_TOO_LATE`).

## 8. Open items / flagged assumptions

- **Assumption:** shift times display in Europe/London regardless of the
  device zone (Flutter uses the device zone; identical for UK devices).
- **Fixed (iPhone and Flutter together):** `formatPence` keeps the sign of a
  negative amount under £1 (-50 used to print "£0.50"; Flutter also printed
  -199 as "£-1.01").
- **Owner decision (money display):** both phone apps print money exactly
  like the website (`@rab/shared` `formatPence`, the en-GB
  `Intl.NumberFormat` currency output): sign before the pound sign and
  thousands separators, `-£1,234.56`. The web, Flutter and iPhone test
  suites all read `packages/rab-shared/src/utils/money-format-cases.json`.
- Login in `reauthRequired` creates a new session family without revoking
  the previous one (Flutter parity); the old family ages out server-side.
  Consider a best-effort `/auth/logout` of the old family first.
- Toast pass-through window is not verified. The app-switcher privacy cover
  exists only on the 2FA setup-key and recovery-code screens (§6), not app-wide.
- THREAT-MODEL.md (repo root) needs an iOS entry for this auth/session
  surface; it is outside this package and was not edited.
