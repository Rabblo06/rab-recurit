# OWASP ASVS 4.0.3 Level 2 review

## 1. Header

| Item | Value |
| --- | --- |
| Standard | OWASP Application Security Verification Standard 4.0.3, Level 2 (every L1 and L2 requirement of V1 to V14; L3-only requirements skipped) |
| Scope | `packages/rab-server` (NestJS API), `packages/rab-worker` (BullMQ worker), `packages/rab-front` (React console), `packages/rab-mobile` (Flutter staff app), `packages/rab-shared`, the PostgreSQL schema and RLS tooling (`tools/check-rls-coverage.ts`), CI (`.github/`), and the deploy definitions in `packages/rab-docker` |
| Commit | `85b070bb` (origin/main, detached worktree) |
| Date | 2026-11-21 |
| Reviewer | Lane F automated desk review. This is a code and document read, not an independent audit and not a penetration test. Nothing was executed: no test suite, no container, no database, no remote host. |

### Method

1. The requirement list was taken from the public ASVS 4.0.3 CSV (OWASP/ASVS tag `v4.0.3`). 259 requirements apply at Level 2.
2. Each control was located with code search and confirmed by opening the file at the cited line. Paths are repo-relative.
3. Where a test proves the control, the spec file and the exact `it(...)` title are given. Test titles are quoted verbatim; a trailing `...` marks a verbatim prefix of a longer title. The tests were read, not run.
4. Anything that lives outside the repository (TLS termination, WAF, DNS, NTP, log shipping, secret storage) is marked `partly` with "not verified (infra)" and is listed in section 6.
5. Where a project document claims a control that the code does not have, the code wins and the drift is noted.

### Status legend

| Status | Meaning |
| --- | --- |
| `met` | The control is present in code or configuration at the cited place, and where possible a test proves it. |
| `partly` | The control exists but is incomplete, off by default, depends on deployment, or could not be verified. |
| `not met` | The control is absent. |
| `N/A` | The requirement does not apply to this system (the reason is given). |

## 2. Summary

| Chapter | met | partly | not met | N/A | Total |
| --- | --- | --- | --- | --- | --- |
| V1 Architecture, design and threat modelling | 30 | 8 | 0 | 0 | 38 |
| V2 Authentication | 28 | 8 | 5 | 12 | 53 |
| V3 Session management | 13 | 3 | 1 | 1 | 18 |
| V4 Access control | 7 | 2 | 0 | 0 | 9 |
| V5 Validation, sanitisation and encoding | 24 | 1 | 0 | 5 | 30 |
| V6 Stored cryptography | 8 | 3 | 1 | 1 | 13 |
| V7 Error handling and logging | 7 | 5 | 0 | 0 | 12 |
| V8 Data protection | 2 | 10 | 3 | 0 | 15 |
| V9 Communication | 2 | 4 | 1 | 0 | 7 |
| V10 Malicious code | 3 | 1 | 0 | 1 | 5 |
| V11 Business logic | 4 | 3 | 1 | 0 | 8 |
| V12 Files and resources | 11 | 2 | 1 | 1 | 15 |
| V13 API and web service | 6 | 3 | 0 | 4 | 13 |
| V14 Configuration | 19 | 2 | 1 | 1 | 23 |
| **Total** | **164** | **55** | **14** | **26** | **259** |

Counts were computed from the chapter tables below; every one of the 259 L1/L2 IDs in the ASVS 4.0.3 CSV appears exactly once.

## 3. Chapter tables

### V1 Architecture, design and threat modelling

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V1.1.1 | Secure development lifecycle covers all stages | met | `CLAUDE.md:16` (binding rules); `SECURITY.md:18`; `.github/workflows/ci-security.yaml:37` (audit, gitleaks, CodeQL, RLS gates) | none |
| V1.1.2 | Threat modelling for every design change | met | `THREAT-MODEL.md:1` (per-feature entries, e.g. `THREAT-MODEL.md:226`); rule in `CLAUDE.md` "Testing floor" | none |
| V1.1.3 | User stories carry functional security constraints | met | abuse-case matrix referenced from `CLAUDE.md` "Testing floor"; e.g. `packages/rab-server/src/__tests__/integration/resource-ownership-abuse-cases.integration.spec.ts` "Manager B cannot GET, UPDATE, or deactivate Staff A by ID — 404, not 403 or the record" | none |
| V1.1.4 | Trust boundaries, components and data flows documented | met | `rab-workforce-architecture.md:399` (system architecture), `rab-workforce-architecture.md:455` (security architecture), `rab-workforce-architecture.md:628` (RLS) | none |
| V1.1.5 | High-level architecture and remote services analysed | met | `rab-workforce-architecture.md:455`; `SECURITY.md:18` (every external secret and service) | none |
| V1.1.6 | Centralised, reusable security controls | met | `packages/rab-server/src/engine/utils/global-validation-pipe.ts:10`; `packages/rab-server/src/engine/guards/permission.guard.ts:24`; `packages/rab-server/src/engine/filters/all-exceptions.filter.ts:58` | none |
| V1.1.7 | Secure coding checklist available to developers | met | `CLAUDE.md:16` (non-negotiable rules); `SECURITY.md:38` | none |
| V1.2.1 | Low-privilege OS accounts per component | met | `packages/rab-docker/rab/Dockerfile:305` (`USER node`); `packages/rab-docker/docker-compose.production.yml:773` (`user: "1000:1000"`), `:527` (db `999:999`) | none |
| V1.2.2 | Inter-component communication authenticated, least privilege | partly | DB: SCRAM + verify-full TLS (`packages/rab-docker/docs/release/OWNER-LOGIN-DEPLOYMENT.md:125`); runtime role check `packages/rab-server/src/__tests__/integration/runtime-db-role.integration.spec.ts` "refuses the superuser login outright" | Redis is unauthenticated in the production compose (`packages/rab-docker/docker-compose.production.yml:543`) |
| V1.2.3 | Single vetted authentication mechanism | met | argon2id password path `packages/rab-server/src/engine/core-modules/auth/services/password-hashing.service.ts:11`; OIDC via the same convergence point `packages/rab-server/src/__tests__/integration/mfa-totp-wave4.integration.spec.ts` "Google sign-in of an enrolled account is challenged at the same convergence point; ..." | none |
| V1.2.4 | All authentication pathways equally strong | partly | Web and OIDC share one second-factor gate (`packages/rab-server/src/__tests__/integration/login-second-factor-gate.integration.spec.ts` "the direct Google provider path is gated at the same convergence point, before the first-time provider link is written") | Mobile sign-in is exempt from MFA by default: `AUTH_MFA_MOBILE_POLICY='exempt'` (`packages/rab-server/src/engine/core-modules/environment/environment-variables.ts:1389`) |
| V1.4.1 | Access control enforced at trusted points | met | Server guards + service checks + RLS (`rab-workforce-architecture.md:477`); `packages/rab-server/src/__tests__/integration/auth-route-inventory.integration.spec.ts` "every route not on the public allow-list runs JwtAuthGuard first" | none |
| V1.4.4 | Single well-vetted access control mechanism | met | `packages/rab-server/src/engine/guards/permission.guard.ts:24` (one mixin); RLS gate `tools/check-rls-coverage.ts:33` | none |
| V1.4.5 | Feature or attribute based access control | met | Permission flags checked per handler `packages/rab-server/src/engine/guards/permission.guard.ts:41`; matrix `rab-workforce-architecture.md:776` | none |
| V1.5.1 | Input and output handling requirements defined | met | DTO whitelist rule `packages/rab-server/src/engine/utils/global-validation-pipe.ts:3`; error contract `rab-workforce-architecture.md:595` | none |
| V1.5.2 | No unsafe serialisation with untrusted clients | met | JSON-only API; no native object deserialisation found in `packages/rab-server/src` | none |
| V1.5.3 | Input validation on a trusted service layer | met | Global pipe applied in `packages/rab-server/src/main.ts:92`; `packages/rab-server/src/__tests__/static/spec-validation-pipe.spec.ts` "main.ts applies the pipe through the shared helper (one definition for production and tests)" | none |
| V1.5.4 | Output encoding close to the interpreter | met | React auto-escaping (no `dangerouslySetInnerHTML`, see `packages/rab-front/src/features/ai/SafeMarkdown.tsx:14`); HTML email escaping `packages/rab-server/src/engine/utils/escape-html.ts:1` | none |
| V1.6.1 | Explicit cryptographic key management policy | met | `SECURITY.md:18` (every secret, its use and rotation) | none |
| V1.6.2 | Key material protected by consumers | met | HKDF purpose-separated keys `packages/rab-server/src/engine/core-modules/secret-encryption/keyring.util.ts:30`; keys never logged (`SECURITY.md:18`) | none |
| V1.6.3 | Keys and passwords replaceable with rotation process | met | `packages/rab-server/src/__tests__/integration/secret-rotation.integration.spec.ts` "apply rotation re-encrypts the legacy record under the active kid, and the plaintext survives" | none |
| V1.6.4 | Client-side secrets treated as insecure | met | No secret in `packages/rab-front` (env holds only public config); mobile keeps only its own refresh token in OS secure storage `packages/rab-mobile/lib/core/api/api_client.dart:159` | none |
| V1.7.1 | Common logging format across the system | partly | One structured request line `packages/rab-server/src/engine/observability/request-context.middleware.ts:44`; structured audit event shape `packages/rab-server/src/engine/core-modules/audit-sink/security-audit-sink.ts:12` | Nest default console logger is used (no JSON logger configured in `packages/rab-server/src/main.ts`); Worker format not verified |
| V1.7.2 | Logs sent to a remote system | partly | External audit sink, mandatory in production `packages/rab-server/src/engine/core-modules/audit-sink/security-audit-sink.ts:20` | Shipping off-host is a deployment dependency (`security-audit-sink.ts:13`); not verified (infra) |
| V1.8.1 | Sensitive data identified and classified | partly | Sensitive columns `select: false` `packages/rab-server/src/modules/identity/entities/user.entity.ts:44`; data protection section `rab-workforce-architecture.md:578` | No formal classification register; doc lists columns that no longer exist (sort code, NI) `rab-workforce-architecture.md:580` |
| V1.8.2 | Protection requirements per protection level | partly | Retention categories `rab-workforce-architecture.md:586` | No level-to-control mapping; retention not enforced (`rab-workforce-architecture.md:586` "no automated enforcement job") |
| V1.9.1 | Communications between components encrypted | partly | DB verify-full enforced at boot `packages/rab-server/src/database/boot-checks/database-boot-gate-rules.ts:591` | Redis traffic is plaintext `redis://rab-redis:6379` (`packages/rab-docker/docker-compose.production.yml:871`) |
| V1.9.2 | Components verify each side's authenticity | partly | DB certificate and host name verified (`database-boot-gate-rules.ts:554`) | Redis has neither TLS nor authentication (`docker-compose.production.yml:543`) |
| V1.10.1 | Source control with change procedures | met | Git, PR workflow, `.github/CODEOWNERS:1` | CODEOWNERS enforces nothing until branch protection is on (`.github/CODEOWNERS:3`) |
| V1.11.1 | Components defined by business function | met | `rab-workforce-architecture.md:204` (layout), `:399` | none |
| V1.11.2 | High-value flows not sharing unsynchronised state | met | `packages/rab-server/src/__tests__/integration/session-auth-correctness.integration.spec.ts` "4: 5 simultaneous refreshes of the SAME token — exactly one winner, real Postgres, no test instrumentation" | none |
| V1.12.2 | Uploaded files served safely (attachment or sandbox) | met | `packages/rab-server/src/engine/core-modules/storage/files.controller.ts:212` (Content-Disposition), `:213` (`default-src 'none'; sandbox`) | none |
| V1.14.1 | Segregation of components of different trust | met | Internal DB network `packages/rab-docker/docker-compose.production.yml:1016` (`internal: true`) | none |
| V1.14.2 | Signatures, trusted connections, verified endpoints for deploy | met | Images pinned by digest `packages/rab-docker/docker-compose.production.yml:574`; provenance attestation `packages/rab-docker/docs/IMAGE_SECURITY_RELEASE_POLICY.md:168` | none |
| V1.14.3 | Pipeline warns of outdated or insecure components | met | `.github/workflows/ci-security.yaml:37` (npm audit high+); `.github/workflows/npm-audit-weekly.yaml:11`; `.github/dependabot.yml:15` | Dependabot covers actions and Docker only, not npm (`.github/dependabot.yml:15`, `:24`) |
| V1.14.4 | Pipeline builds and verifies secure deployment | met | `.github/workflows/image-security-gate.yaml:177`; `.github/workflows/ci-security.yaml:127` (FORCE RLS check) | none |
| V1.14.5 | Deployments sandboxed or containerised | met | `packages/rab-docker/docker-compose.production.yml:774` (`read_only`, `cap_drop: [ALL]`, `no-new-privileges`) | OpenShip drops these keys (`docker-compose.production.yml:19`); see section 6 |
| V1.14.6 | No unsupported or deprecated client-side technology | met | React (`packages/rab-front`) and Flutter (`packages/rab-mobile`) only; no plugins | none |

### V2 Authentication

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V2.1.1 | User passwords at least 12 characters | not met | `MIN_PASSWORD_LENGTH = 10` `packages/rab-shared/src/utils/password.ts:14` | Minimum is 10, not 12 |
| V2.1.2 | Passwords of 64+ characters permitted, 128 max | met | `MAX_PASSWORD_LENGTH = 128` `packages/rab-shared/src/utils/password.ts:16` | none |
| V2.1.3 | No password truncation | met | argon2id hashes the full input (`password-hashing.service.ts:19`); over-long input is rejected, not cut: `packages/rab-server/src/__tests__/integration/auth-abuse-cases.integration.spec.ts` "rejects a password longer than the maximum with 400, including against an unknown email (dummy-hash path)" | none |
| V2.1.4 | Any printable Unicode allowed | met | No character-set restriction in `packages/rab-shared/src/utils/password.ts:23` | No Unicode normalisation before hashing (not required at L2) |
| V2.1.5 | Users can change their password | partly | Forgot-password reset `packages/rab-server/src/engine/core-modules/auth/controllers/auth.controller.ts:447`; forced reset `auth.controller.ts:438` | No voluntary self-service change; `setPassword` works only while `mustResetPassword` is true (`packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts:934`) |
| V2.1.6 | Change requires current and new password | not met | `auth.service.ts:934` doc comment: voluntary change "isn't part of this feature" | No change-password endpoint that verifies the current password |
| V2.1.7 | Passwords checked against breached-password set | partly | 15-entry common list `packages/rab-shared/src/utils/password.ts:8` | No breached-password check (k-anonymity HIBP or a large local list) |
| V2.1.8 | Password strength meter provided | partly | Live rule feedback `packages/rab-front/src/features/auth/ActivateAccount.tsx:47` | Pass/fail rules only, no strength meter |
| V2.1.9 | No composition rules | not met | Upper, lower and digit required `packages/rab-shared/src/utils/password.ts:32` | Composition rule present |
| V2.1.10 | No periodic rotation or history requirement | met | No expiry or history column; `mustResetPassword` is set only on creation or admin reset (`packages/rab-server/src/modules/identity/entities/user.entity.ts:84`) | none |
| V2.1.11 | Paste and password managers allowed | met | No paste blocking in `packages/rab-front/src/features/auth`; `autoComplete="new-password"` `packages/rab-front/src/features/auth/AcceptInvitation.tsx:202` | none |
| V2.1.12 | User can view the masked password | met | Show/hide toggle `packages/rab-front/src/features/auth/AcceptInvitation.tsx:207`, `ActivateAccount.tsx:42` | none |
| V2.2.1 | Anti-automation against credential stuffing and brute force | met | `packages/rab-server/src/engine/core-modules/auth/services/login-attempt-limiter.service.ts:23`; `packages/rab-server/src/__tests__/integration/login-attempt-limiter.integration.spec.ts` "distributed guessing (many IPs, one account) hits the account-wide ceiling for unknown addresses, while the owner's known address still signs in" | none |
| V2.2.2 | Weak authenticators limited to secondary use | met | No SMS factor; email used only for activation/reset links (`packages/rab-server/src/engine/core-modules/auth/services/account-lifecycle.service.ts:187`) | none |
| V2.2.3 | Notifications after authentication detail changes | met | Password change email `auth.service.ts:959`; MFA change notice `packages/rab-server/src/engine/core-modules/auth/services/mfa-security-notice.service.ts:10`; `packages/rab-server/src/__tests__/integration/email-change-takeover.integration.spec.ts` "the takeover chain is broken: the change is only pending, the old owner is told, and a reset to the new address does nothing" | none |
| V2.3.1 | Initial secrets random, short-lived | partly | Tokens from `randomBytes(32)` `packages/rab-server/src/engine/core-modules/auth/token/services/password-reset-token.service.ts:49`; staff temporary password never disclosed `packages/rab-server/src/modules/staff/services/staff.service.ts:695` | Activation and reset tokens live 48 hours (`password-reset-token.service.ts:9`) |
| V2.3.2 | User-provided authenticator devices (FIDO/U2F) supported | not met | TOTP only (`packages/rab-server/src/engine/core-modules/auth/mfa/totp.ts:4`) | No WebAuthn/FIDO2 |
| V2.3.3 | Renewal instructions for time-bound authenticators | N/A | No time-bound authenticators (no client certificates or expiring tokens issued to users) | none |
| V2.4.1 | Passwords stored with approved salted one-way KDF | met | argon2id `packages/rab-server/src/engine/core-modules/auth/services/password-hashing.service.ts:12`; `password-hashing.service.spec.ts` "produces an argon2id hash" | none |
| V2.4.2 | Salt at least 32 bits, unique | met | argon2 random per-hash salt; `packages/rab-server/src/engine/core-modules/auth/services/password-hashing.service.spec.ts` "salts each hash independently — same password, different hash" | none |
| V2.4.3 | PBKDF2 iteration count | N/A | PBKDF2 not used | none |
| V2.4.4 | bcrypt work factor | N/A | bcrypt not used | none |
| V2.4.5 | Additional KDF iteration with secret salt (pepper) | not met | `password-hashing.service.ts:11` has no secret input | No pepper or keyed final step |
| V2.5.1 | Initial or recovery secret not sent in clear text | met | Staff temporary password hashed, never sent (`packages/rab-server/src/modules/staff/services/staff.service.ts:685`); activation is a one-time link | none |
| V2.5.2 | No password hints or secret questions | met | None found in `packages/rab-server/src/engine/core-modules/auth` | none |
| V2.5.3 | Recovery does not reveal the current password | met | Reset sets a new hash (`auth.service.ts:1087`) | none |
| V2.5.4 | No shared or default accounts | met | `packages/rab-server/src/__tests__/integration/bootstrap-admin.integration.spec.ts` "a leftover BOOTSTRAP_ADMIN_PASSWORD is ignored (never applied, never fatal) ..." | none |
| V2.5.5 | User notified when a factor changes | met | `mfa-security-notice.service.ts:10`; `auth.service.ts:151` | none |
| V2.5.6 | Secure recovery mechanism | met | Hashed single-use token `password-reset-token.service.ts:28`; sessions revoked on reset `auth.service.ts:1122`; timing floor `auth.service.ts:981` | none |
| V2.5.7 | Lost OTP recovery uses proofing like enrolment | met | `packages/rab-server/src/__tests__/integration/mfa-totp-wave4.integration.spec.ts` "ABUSE: admin reset is platform-admin only, needs a reason + the admin's fresh proof ..." | none |
| V2.6.1 | Lookup secrets usable once | met | `mfa-totp-wave4.integration.spec.ts` "ABUSE: a recovery code works exactly once; regeneration needs password + a factor and invalidates the old set" | none |
| V2.6.2 | Lookup secrets 112 bits, or salted and hashed | partly | 80-bit codes `packages/rab-server/src/engine/core-modules/auth/mfa/recovery-codes.ts:6`; SHA-256 with a fixed domain label `recovery-codes.ts:52` | Below 112 bits and no per-code random salt |
| V2.6.3 | Lookup secrets resistant to offline attack | met | `crypto.randomInt` rejection sampling `recovery-codes.ts:7` | none |
| V2.7.1 | No clear-text out-of-band authenticators by default | met | No SMS or PSTN factor in `packages/rab-server/src/engine/core-modules/auth/mfa` | none |
| V2.7.2 | OOB requests expire after 10 minutes | N/A | No OOB authenticator; email links are recovery, assessed under V2.5 | none |
| V2.7.3 | OOB codes single use | N/A | No OOB authenticator | none |
| V2.7.4 | OOB channel secure and independent | N/A | No OOB authenticator | none |
| V2.7.5 | OOB verifier keeps only hashed codes | N/A | No OOB authenticator (reset tokens are hashed anyway: `password-reset-token.service.ts:28`) | none |
| V2.7.6 | OOB code from secure RNG, 20 bits | N/A | No OOB authenticator | none |
| V2.8.1 | Time-based OTP has a defined lifetime | met | 30 s step, one-step window `packages/rab-server/src/engine/core-modules/auth/mfa/totp.ts:19`, `:22` | none |
| V2.8.2 | OTP symmetric keys highly protected | met | AES-256-GCM envelope, `select: false` `packages/rab-server/src/modules/identity/entities/user.entity.ts:78`; `mfa-totp-wave4.integration.spec.ts` "enrolment: needs the current password; the secret is generated server-side and stored only as an RAB2 envelope; ..." | none |
| V2.8.3 | Approved algorithms for OTP | met | RFC 6238 HMAC-SHA1, 160-bit secret `totp.ts:4`, `:24` | none |
| V2.8.4 | TOTP usable once per validity period | met | Last used step stored `packages/rab-server/src/engine/core-modules/auth/mfa/mfa-store.ts:8`; `mfa-totp-wave4.integration.spec.ts` "ABUSE: replay of the same code, an older step and a parallel replay are all refused; a fresh step signs in" | none |
| V2.8.5 | Reused TOTP logged and user notified | partly | Failure audited (`MFA_CHALLENGE_FAILED`, `packages/rab-server/src/engine/core-modules/audit/audit.service.ts:261`) | Replay is not distinguished from a wrong code and the user is not notified |
| V2.8.6 | Physical OTP generators revocable | N/A | No hardware OTP tokens | none |
| V2.8.7 | Biometrics only as secondary factor | met | Biometric only unlocks a locally stored credential `packages/rab-mobile/lib/core/auth/biometric_store.dart:2` | none |
| V2.9.1 | Cryptographic authenticator keys stored securely | N/A | No cryptographic (certificate/FIDO) authenticators | none |
| V2.9.2 | Challenge nonce at least 64 bits | N/A | No cryptographic authenticators | none |
| V2.9.3 | Approved algorithms for cryptographic authenticators | N/A | No cryptographic authenticators | none |
| V2.10.1 | Intra-service secrets not static credentials | partly | DB login uses generated 32+ char password (`OWNER-LOGIN-DEPLOYMENT.md:278`) | Static DB password; Redis has no credential at all (`docker-compose.production.yml:543`) |
| V2.10.2 | Service accounts not default credentials | met | `crewflow_owner` password must be 32+ random chars (`packages/rab-docker/docs/release/OWNER-LOGIN-DEPLOYMENT.md:278`) | none |
| V2.10.3 | Service passwords protected against offline recovery | partly | DB verifier stored as SCRAM (`OWNER-LOGIN-DEPLOYMENT.md:144`) | Runtime secrets live in env files; storage not verified (infra) |
| V2.10.4 | Secrets not in source code | met | gitleaks `.github/workflows/ci-security.yaml:67`; `packages/rab-server/src/__tests__/static/no-static-fixture-password.spec.ts` | none |

### V3 Session management

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V3.1.1 | Session tokens never in URL parameters | met | Cookie or body transport `packages/rab-server/src/__tests__/integration/auth-abuse-cases.integration.spec.ts` "login sets an HttpOnly refresh cookie and never returns the refresh token in the body; refresh rotates it the same way"; handoff token in URL fragment only `packages/rab-server/src/engine/core-modules/auth/login-handoff/login-handoff.service.ts:38` | none |
| V3.2.1 | New session token on authentication | met | `packages/rab-server/src/__tests__/integration/profile-devices-sessions.integration.spec.ts` "2. re-login from the SAME browser supersedes only that browser's session; a login from another device keeps both" | none |
| V3.2.2 | Session tokens at least 64 bits entropy | met | `randomBytes(32)` `packages/rab-server/src/engine/core-modules/auth/token/services/refresh-token.service.ts:85`, `:130` | none |
| V3.2.3 | Tokens stored securely in the browser | met | HttpOnly cookies `packages/rab-server/src/engine/core-modules/auth/constants/auth-cookie-policy.ts:121`; front holds no token in storage | none |
| V3.2.4 | Tokens from approved cryptographic algorithms | met | Node CSPRNG `refresh-token.service.ts:85`; stored as SHA-256 `refresh-token.service.ts:76` | none |
| V3.3.1 | Logout and expiry invalidate the session | met | `packages/rab-server/src/__tests__/integration/session-auth-correctness.integration.spec.ts` "14: logout invalidates the OLD access JWT immediately — no residual authorization window" | none |
| V3.3.2 | Re-authentication: L2 12 h or 30 min idle | not met | Manager web 180 d absolute / 30 d idle, staff app 90 d / 7 d `packages/rab-server/src/engine/core-modules/auth/session-policy.ts:57`, `:136`; platform admin 24 h / 30 min `session-policy.ts:63` | Only platform admins come close; every other class far exceeds the L2 bound |
| V3.3.3 | Option to end other sessions after password change | met | All sessions revoked on change/reset `auth.service.ts:957`, `:1122`; `profile-devices-sessions.integration.spec.ts` "11/12/17/21. \"log out other devices\" keeps this one ..." | none |
| V3.3.4 | View sessions and log out others after re-auth | partly | Session list and revoke `packages/rab-server/src/modules/identity/controllers/profile.controller.ts:76`, `:87` | Revoking other sessions needs no re-entered credentials |
| V3.4.1 | Cookie Secure attribute | met | `secure: true` in host mode, `secure: isProduction` in legacy `auth-cookie-policy.ts:121`; `packages/rab-server/src/engine/core-modules/auth/constants/refresh-cookie.constants.ts:39` | none |
| V3.4.2 | Cookie HttpOnly attribute | met | `auth-cookie-policy.ts:121`; `auth-cookie-policy.spec.ts` "%s: __Host- name, HttpOnly, Secure, Path=/, no Domain (even outside production)" | none |
| V3.4.3 | Cookie SameSite attribute | partly | `sameSiteFor` `auth-cookie-policy.ts:83` | Session and refresh cookies are `SameSite=None` in production (`auth-cookie-policy.ts:87`); CSRF relies on the Origin check (V4.2.2) |
| V3.4.4 | Cookies use the `__Host-` prefix | partly | Implemented `auth-cookie-policy.ts:42` | Off by default: `AUTH_COOKIE_HOST_PREFIX_ENABLED=false` (`packages/rab-server/src/engine/core-modules/environment/environment-variables.ts:298`, `packages/rab-docker/docker-compose.production.yml:198`) |
| V3.4.5 | Cookie path set tightly when domain shared | met | Legacy cookies scoped to `/rest/v1` and `/rest/v1/auth` (`auth-cookie-policy.ts:20`) | none |
| V3.5.1 | Users can revoke OAuth tokens of linked apps | N/A | The app grants no OAuth tokens to third-party apps | none |
| V3.5.2 | Session tokens, not static API keys | met | Per-session JWT and refresh family (`refresh-token.service.ts:85`); no user API keys | none |
| V3.5.3 | Stateless tokens protected by signature | met | HS256 with fixed algorithm, issuer, audience `packages/rab-server/src/engine/core-modules/auth/token/services/access-token.service.ts:35`, `:135` | none |
| V3.7.1 | Re-auth before sensitive actions | met | `packages/rab-server/src/engine/core-modules/auth/services/step-up-reauth.service.ts:211`; `packages/rab-server/src/__tests__/integration/lane-d-step-up-adoption.integration.spec.ts` "ABUSE: every gated route refuses a STALE session with 403 STEP_UP_REQUIRED, writes nothing, and audits the refusal with its action" | none |

### V4 Access control

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V4.1.1 | Access control enforced on a trusted service layer | met | Layer 2 in services: `packages/rab-server/src/__tests__/integration/lane-d-step-up-adoption.integration.spec.ts` "ABUSE: service-direct calls (no controller, no guard) are refused the same way — no session, a stale session, or Admin Inspect"; `packages/rab-server/src/__tests__/integration/layer2-service-permission-hardening.integration.spec.ts` "create(): without SCHEDULE_CREATE → 403, no shift row and no shift.created audit row" | none |
| V4.1.2 | Access control attributes not user-manipulable | met | `organisationId` from session only; `packages/rab-server/src/__tests__/integration/organisation-isolation.integration.spec.ts` "forged tenant headers, query parameters and a tampered token never change the session organisation" | none |
| V4.1.3 | Least privilege | met | Role matrix `rab-workforce-architecture.md:776`; non-bypass runtime DB role `tools/check-rls-coverage.ts:28` | none |
| V4.1.5 | Access controls fail securely | met | Missing snapshot denies (`?? false`) `packages/rab-server/src/engine/guards/permission.guard.ts:41`; `packages/rab-server/src/__tests__/integration/stored-file-workspace-policy.integration.spec.ts` "a query with NO tenant context bound returns zero stored_file rows (fail closed)" | none |
| V4.2.1 | Protection against IDOR | met | `organisation-isolation.integration.spec.ts` "mutations of Organisation 2 records return 404 and change nothing"; `packages/rab-server/src/__tests__/integration/user-deletion-abuse-cases.integration.spec.ts` "Manager A cannot delete Staff created by Manager B (creator-private, 404 not 403)" | none |
| V4.2.2 | Strong anti-CSRF mechanism | met | Origin check on cookie unsafe requests `packages/rab-server/src/engine/core-modules/auth/guards/jwt-auth.guard.ts:251`; `packages/rab-server/src/__tests__/integration/login-csrf.integration.spec.ts` "JSON from an untrusted Origin, or from an opaque \"null\" Origin, is refused (403) and sets no cookie" | none |
| V4.3.1 | Admin interfaces use MFA | partly | TOTP available; enforcement switch exists `packages/rab-server/src/engine/core-modules/environment/environment-variables.ts:1359` | `AUTH_MFA_ENFORCE_PLATFORM_ADMIN` defaults to `false` (also `packages/rab-docker/docker-compose.production.yml:244`); `mfa-totp-wave4.integration.spec.ts` "enforcement defaults OFF: ..." confirms |
| V4.3.2 | Directory browsing disabled; no metadata exposed | met | API serves no static files; front is an SPA rewrite `packages/rab-front/vercel.json:6` | none |
| V4.3.3 | Step-up or segregation for high-value actions | partly | Step-up gates roles, members, staff, manager, admin and AI actions (`step-up-reauth.service.ts:211` callers) | Payroll approval/export is not step-up gated (no `assertRecentStepUp` in `packages/rab-server/src/modules/payroll`) |

### V5 Validation, sanitisation and encoding

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V5.1.1 | Defence against HTTP parameter pollution | partly | Express 5 (Nest 11) simple query parser `packages/rab-server/package.json:23`; typed DTOs `global-validation-pipe.ts:10` | No dedicated test |
| V5.1.2 | Protection against mass assignment | met | `forbidNonWhitelisted: true` `packages/rab-server/src/engine/utils/global-validation-pipe.ts:12`; `auth-abuse-cases.integration.spec.ts` "rejects a request body carrying unknown fields (e.g. organisationId/organisationSlug injection attempt)" | none |
| V5.1.3 | All input validated with allow lists | met | `whitelist: true` `global-validation-pipe.ts:11`; `packages/rab-server/src/__tests__/integration/path-param-uuid-validation.integration.spec.ts` "a malformed nested identifier is refused the same way" | none |
| V5.1.4 | Structured data strongly typed and schema-validated | met | class-validator DTOs, e.g. `packages/rab-server/src/engine/core-modules/auth/dto/login.dto.ts:21` | none |
| V5.1.5 | Redirects only to allow-listed destinations | met | `packages/rab-server/src/engine/core-modules/auth/services/oauth-transaction-state.service.ts:89`; `packages/rab-server/src/__tests__/integration/p1c1b-auth-providers.integration.spec.ts` "an absolute or protocol-relative returnToPath is sanitised to \"/\" rather than stored as-is" | none |
| V5.2.1 | Untrusted HTML sanitised | met | No rich-text HTML input; AI markdown rendered without raw HTML `packages/rab-front/src/features/ai/SafeMarkdown.tsx:14` | none |
| V5.2.2 | Unstructured data sanitised (length, characters) | met | MaxLength on DTO fields, e.g. `packages/rab-server/src/engine/core-modules/auth/dto/mfa.dto.ts:70` | none |
| V5.2.3 | Input sanitised before mail systems | met | Fixed subjects `packages/rab-server/src/engine/core-modules/email/templates.ts:36`; escaped body values `escape-html.ts:1` | none |
| V5.2.4 | No eval or dynamic code execution | met | No `eval`/`new Function` in request paths; front CSP `script-src 'self'` `packages/rab-front/vercel.json:13` | none |
| V5.2.5 | Protection against template injection | met | React-email components with props (`packages/rab-emails`); no user-supplied templates | none |
| V5.2.6 | Protection against SSRF | met | No user-supplied outbound URL; PDF renderer refuses network fetch `packages/rab-worker/src/queues/rab-reports/native/runtime/thread-guard.ts:13` | none |
| V5.2.7 | User SVG sanitised or disabled | met | PNG/JPEG/WEBP allow-list by magic bytes `packages/rab-server/src/engine/core-modules/storage/image-sniff.ts:3` | none |
| V5.2.8 | Scriptable template content sanitised | met | `SafeMarkdown.tsx:14` | none |
| V5.3.1 | Output encoding for interpreter and context | met | React JSX escaping; `escape-html.ts:13` for HTML email | none |
| V5.3.2 | Output encoding preserves character set | met | JSON responses UTF-8 (Express `res.json`) | none |
| V5.3.3 | Context-aware output escaping against XSS | met | No `dangerouslySetInnerHTML` in `packages/rab-front/src` (only a comment in `SafeMarkdown.tsx:14`) | none |
| V5.3.4 | Parameterised queries | met | `tools/check-sql-injection.cjs` in `.github/workflows/ci-security.yaml:159`; `packages/rab-server/src/__tests__/security/sql-injection-adversarial.spec.ts` "a valid filter compiles to fixed column SQL with the value only as a positional parameter" | none |
| V5.3.5 | Context escaping where parameters unavailable | met | `packages/rab-server/src/engine/utils/ilike-pattern.util.ts:12`; `sql-injection-adversarial.spec.ts` "a valid workspace id maps to exactly workspace_<32 hex>" | none |
| V5.3.6 | Protection against JSON injection | met | Server builds JSON only via `res.json`; parsing via body-parser | none |
| V5.3.7 | Protection against LDAP injection | N/A | No LDAP | none |
| V5.3.8 | Protection against OS command injection | met | `child_process` used only in operator scripts under `packages/rab-server/src/database/typeorm/scripts`, never with request data | none |
| V5.3.9 | Protection against LFI/RFI | met | Opaque server-generated storage keys: `packages/rab-server/src/__tests__/integration/file-storage-security.integration.spec.ts` "a signed URL is NEVER stored: the metadata row has no URL and the key is an opaque server-generated path" | none |
| V5.3.10 | Protection against XPath/XML injection | N/A | No XML or XPath processing | none |
| V5.4.1 | Memory-safe string handling | N/A | Managed runtimes (TypeScript, Dart); no project native code | none |
| V5.4.2 | Format strings not attacker-controlled | N/A | No C-style format string APIs | none |
| V5.4.3 | Integer overflow prevented | met | Money as bigint pence (`CLAUDE.md` rule); `packages/rab-server/src/engine/utils/pence-number-boundary.spec.ts` | none |
| V5.5.1 | Serialised objects integrity-protected | met | Only signed JWTs cross the trust boundary (`access-token.service.ts:135`) | none |
| V5.5.2 | XML parsers restricted (no XXE) | N/A | No XML parser | none |
| V5.5.3 | Untrusted deserialisation avoided | met | JSON only; no native serialisation libraries in `packages/rab-server/package.json` | none |
| V5.5.4 | JSON.parse used, not eval | met | Body-parser / `JSON.parse` only; e.g. `packages/rab-front/src/features/users/UserProfile.tsx:116` | none |

### V6 Stored cryptography

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V6.1.1 | Regulated private data encrypted at rest | partly | TOTP secrets encrypted `packages/rab-server/src/modules/identity/entities/user.entity.ts:78` | Date of birth, phone, emergency contact, right-to-work stored as plain columns `packages/rab-server/src/modules/staff/entities/staff-profile.entity.ts:35`, `:56`, `:97`; volume encryption not verified (infra) |
| V6.1.2 | Regulated health data encrypted at rest | N/A | No health data columns found in entities | none |
| V6.1.3 | Regulated financial data encrypted at rest | partly | No bank details stored | Pay rates and payroll amounts plain (`staff-profile.entity.ts:44`); doc claims bank/NI encryption that no longer matches code (`rab-workforce-architecture.md:580`) |
| V6.2.1 | Crypto modules fail securely | met | GCM auth-tag check throws `packages/rab-server/src/engine/core-modules/secret-encryption/secret-encryption.service.ts:143` | none |
| V6.2.2 | Approved algorithms, modes and libraries | met | AES-256-GCM `secret-encryption.service.ts:86`; HKDF-SHA256 `keyring.util.ts:30`; argon2id | none |
| V6.2.3 | IV, cipher and mode configured securely | met | 12-byte random IV `secret-encryption.service.ts:7`, `:85` | none |
| V6.2.4 | Algorithms replaceable (crypto agility) | met | Versioned envelope with `kid` `secret-encryption.service.ts:35`; rotation command `packages/rab-server/src/command/secret-rotation.command.ts` | none |
| V6.2.5 | No insecure modes, padding or weak hashes | met | No ECB/CBC/MD5 in security paths; SHA-1 only inside RFC 6238 HMAC (`totp.ts:55`) | none |
| V6.2.6 | Nonces and IVs never reused per key | met | Fresh random 96-bit IV per encryption `secret-encryption.service.ts:85` | none |
| V6.3.1 | Random values from a CSPRNG | met | `crypto.randomBytes` (`refresh-token.service.ts:85`); `crypto.getRandomValues` `packages/rab-shared/src/utils/password.ts:62` | none |
| V6.3.2 | GUIDs are v4 from a CSPRNG | met | `randomUUID()` `refresh-token.service.ts:86` | none |
| V6.4.1 | Secrets management solution (vault) used | partly | Keyrings with rotation `SECURITY.md:24` | Secrets supplied as env values; no vault or KMS |
| V6.4.2 | Key material isolated (vault/HSM) | not met | `APP_SECRET` and keyrings are read into the API process (`SECURITY.md:22`) | No isolated key service |

### V7 Error handling and logging

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V7.1.1 | Credentials and tokens not logged | met | Request log never holds tokens `packages/rab-server/src/engine/observability/request-context.ts:10`; Sentry scrubbing `packages/rab-server/src/instrument.ts:7`; `packages/rab-server/src/instrument.spec.ts` "turns default PII off and never enables local variables or extraErrorData" | none |
| V7.1.2 | Other sensitive data not logged | partly | Emails masked in audit shipping `packages/rab-server/src/engine/core-modules/audit-events/audit-event-queue.service.ts:162`; email outbox token scrub `packages/rab-server/src/engine/core-modules/email/email-outbox.service.ts:17` | Deleted user's email kept in `audit_log.metadata` (`rab-workforce-architecture.md:591`) |
| V7.1.3 | Security events logged | met | Catalogue `packages/rab-server/src/engine/core-modules/audit-events/security-audit-event-catalogue.ts:46`; actions `packages/rab-server/src/engine/core-modules/audit/audit.service.ts:17` | none |
| V7.1.4 | Log events carry enough detail for a timeline | met | `login_history` with IP and user agent `packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts:251`; audit rows carry actor and target | HTTP request lines carry no actor (by design, `request-context.ts:10`) |
| V7.2.1 | All authentication decisions logged | met | Success `audit.service.ts:18`; failure `security-audit-event-catalogue.ts:44`; MFA `audit.service.ts:259` | none |
| V7.2.2 | Access control decisions loggable; failures logged | partly | File denials audited: `packages/rab-server/src/__tests__/integration/file-storage-security.integration.spec.ts` "the Staff denial is AUDITED (the row was visible to RLS, the per-kind policy refused it)"; step-up refusals audited | Generic `PermissionGuard` 403s are not logged (`packages/rab-server/src/engine/guards/permission.guard.ts:43`) |
| V7.3.1 | Log injection prevented | partly | Structured objects in request log `request-context.middleware.ts:54`; Sentry free-text redaction `instrument.ts:116` | Console logger output format not verified to be JSON; free-text log messages not CR/LF-encoded |
| V7.3.3 | Security logs protected from tampering | partly | `audit_log` grants: `packages/rab-server/src/__tests__/integration/audit-log-abuse-cases.integration.spec.ts` "crewflow — the owner of audit_log since the single-credential cutover — cannot UPDATE, DELETE, or TRUNCATE it ..." | Owner login can re-grant itself (G-05, `packages/rab-server/src/engine/core-modules/audit-sink/security-audit-sink.ts:5`); the external sink is best effort (`security-audit-sink.ts:8`) |
| V7.3.4 | Time sources synchronised, UTC | partly | Timestamps are `timestamptz` (e.g. `staff-profile.entity.ts:140`) | Host clock sync not verified (infra) |
| V7.4.1 | Generic error message on unexpected errors | met | `packages/rab-server/src/engine/filters/all-exceptions.filter.ts:124`; `all-exceptions.filter.spec.ts` "converts an unexpected error to a generic 500 that never echoes the error message" | none |
| V7.4.2 | Exception handling used consistently | met | One global filter `all-exceptions.filter.ts:58`; not-found mapping `all-exceptions.filter.ts:82` | none |
| V7.4.3 | Last-resort error handler | met | `all-exceptions.filter.ts:124`; `all-exceptions.filter.spec.ts` "a throwing handler never changes the response: still the same generic 500 body" | none |

### V8 Data protection

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V8.1.1 | Sensitive data not cached in server components | partly | File and payslip routes `no-store` `packages/rab-server/src/engine/core-modules/storage/files.controller.ts:74`, `packages/rab-server/src/modules/payroll/controllers/payroll.controller.ts:86` | Ordinary JSON API responses carry no `Cache-Control` (no global header in `packages/rab-server/src/main.ts`) |
| V8.1.2 | Cached or temporary server copies protected and purged | partly | Auth cache entries are MAC-protected (`SECURITY.md:27`) | Expiry of all Redis cache entries not verified |
| V8.1.3 | Minimal request parameters | met | DTO whitelisting `global-validation-pipe.ts:11` | none |
| V8.1.4 | Detect and alert on abnormal request volumes | partly | Throttling 120/min/IP `packages/rab-server/src/engine/core-modules/throttler/throttler-options.factory.ts:15`; `packages/rab-server/src/__tests__/integration/rate-limiting.integration.spec.ts` "the GLOBAL limit (120/min/IP) answers the 121st request with 429 and a Retry-After in seconds, which pollers rely on" | No alerting |
| V8.2.1 | Anti-caching headers for sensitive data | partly | As V8.1.1 | No `Cache-Control: no-store` on authenticated JSON |
| V8.2.2 | No sensitive data in browser storage | partly | Tokens are HttpOnly cookies only | Free-text staff notes saved in `localStorage` `packages/rab-front/src/features/users/UserProfile.tsx:110` |
| V8.2.3 | Client storage cleared after session ends | not met | No `localStorage.clear`/`removeItem` on logout in `packages/rab-front/src` | Notes keyed by user id survive logout and account switch (`UserProfile.tsx:114`) |
| V8.3.1 | Sensitive data in body or headers, not URL | partly | Credentials in JSON body or cookies | Reset, activation and email-change tokens in query strings (`packages/rab-server/src/engine/core-modules/auth/services/account-lifecycle.service.ts:187`); mitigated by `Referrer-Policy: no-referrer` (`packages/rab-front/vercel.json:17`) |
| V8.3.2 | Users can export or delete their data | not met | Admin-initiated deletion exists (`packages/rab-server/src/__tests__/integration/user-deletion-abuse-cases.integration.spec.ts`) | No self-service export or erasure request |
| V8.3.3 | Clear language on data collection and use | not met | `packages/rab-website/app/[legal]/page.tsx:36` ("Approved policy pending") | Privacy notice is a placeholder |
| V8.3.4 | Sensitive data identified with a handling policy | partly | `rab-workforce-architecture.md:578` | No complete inventory (see V1.8.1) |
| V8.3.5 | Access to sensitive data audited | partly | File downloads audited `file-storage-security.integration.spec.ts` "a successful download is audited as authorized (evidence access trail)"; Admin Inspect audited | Reads of staff personal data are not audited |
| V8.3.6 | Sensitive memory overwritten after use | partly | Secrets held in short-lived Buffers (`totp.ts:46`) | JS strings cannot be zeroed; not verified |
| V8.3.7 | Encrypted data uses confidentiality and integrity | met | AES-256-GCM `secret-encryption.service.ts:86` | none |
| V8.3.8 | Personal data subject to retention classification | partly | Policy `rab-workforce-architecture.md:586`; token retention enforced `packages/rab-server/src/__tests__/integration/refresh-token-reuse-retention.integration.spec.ts` "cleanup DOES eventually delete a revoked token once it passes the 181-day retention boundary ..." | No enforcement job for audit or personal data (`rab-workforce-architecture.md:586`) |

### V9 Communication

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V9.1.1 | TLS for all client connectivity, no fallback | partly | HSTS from Helmet `packages/rab-server/src/main.ts:102` and `packages/rab-front/vercel.json:18` | TLS terminates at the edge (Cloudflare/Vercel); not verified (infra) |
| V9.1.2 | Only strong cipher suites | partly | none in repo | Edge configuration; not verified (infra) |
| V9.1.3 | Only current TLS versions (1.2/1.3) | partly | none in repo | Edge configuration; not verified (infra) |
| V9.2.1 | Trusted certificates for server connections | met | Production refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` `packages/rab-server/src/database/boot-checks/database-boot-gate-rules.ts:580`; DB verify-full `packages/rab-server/src/database/postgres/create-pg-pool.ts:243` | none |
| V9.2.2 | TLS for all inbound and outbound connections | partly | DB TLS mandatory (`OWNER-LOGIN-DEPLOYMENT.md:125`) | Redis plaintext (`docker-compose.production.yml:871`) |
| V9.2.3 | External encrypted connections authenticated | met | Provider SDKs over HTTPS (S3, Resend, Sentry); DB verify-full | none |
| V9.2.4 | Certificate revocation checked | not met | Node default TLS does no OCSP/CRL checking | No revocation checking configured |

### V10 Malicious code

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V10.2.1 | No unauthorised phone-home or data collection | met | Sentry only when `SENTRY_DSN` set, PII off `packages/rab-server/src/instrument.spec.ts` "returns undefined (no init) when SENTRY_DSN is unset or empty" | none |
| V10.2.2 | No excessive app permissions | met | Internet, biometric, camera (QR), location (geofence) only `packages/rab-mobile/android/app/src/main/AndroidManifest.xml:2` | none |
| V10.3.1 | Auto-update over a secure, signed channel | N/A | No self-update feature; mobile updates via app stores | none |
| V10.3.2 | Integrity protection (signing, SRI) | met | Image provenance attested `packages/rab-docker/docs/IMAGE_SECURITY_RELEASE_POLICY.md:168`; actions pinned by SHA (`.github/dependabot.yml:9`) | none |
| V10.3.3 | Protection from subdomain takeover | partly | Workspace host labels released through a registry (`released_host_label`, `CLAUDE.md` exception list) | DNS hygiene is outside the repo; not verified (infra) |

### V11 Business logic

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V11.1.1 | Flows processed in order, same user | met | `assertTransition` `packages/rab-shared/src/state/assert-transition.ts:12`; `packages/rab-server/src/__tests__/integration/scheduling-offer-abuse-cases.integration.spec.ts` "a manager cannot confirm an offer that is still pending (staff has not accepted yet)" | none |
| V11.1.2 | Steps processed in realistic human time | partly | MFA challenge TTL `environment-variables.ts:1397` | No general timing control; not verified per flow |
| V11.1.3 | Limits per business action | partly | Preview batch caps `file-storage-security.integration.spec.ts` "3: exactly the maximum item count (32) is accepted, not rejected off-by-one" | Per-class limits in `rab-workforce-architecture.md:599` are design intent; most are not verified in code |
| V11.1.4 | Anti-automation against excessive calls | met | Global throttler `throttler-options.factory.ts:15`; `rate-limiting.integration.spec.ts` "throttles repeated /auth/forgot-password attempts the same way" | none |
| V11.1.5 | Business logic limits and validation | met | `scheduling-offer-abuse-cases.integration.spec.ts` "staff cannot confirm their own accepted offer — the endpoint requires OFFER_CONFIRM, which staff never has" | none |
| V11.1.6 | No TOCTOU races on sensitive operations | met | `session-auth-correctness.integration.spec.ts` "3: 2 simultaneous refreshes of the SAME token — exactly one succeeds"; `packages/rab-server/src/__tests__/integration/login-attempt-limiter.integration.spec.ts` "concurrent failures are counted atomically: of 10 simultaneous bad attempts exactly the burst (3) reach the password check" | none |
| V11.1.7 | Monitoring for unusual business activity | partly | Security events shipped `security-audit-event-catalogue.ts:46` | No detection rules |
| V11.1.8 | Configurable alerting on attacks | not met | none in repo | No alerting |

### V12 Files and resources

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V12.1.1 | Large files rejected | met | `packages/rab-server/src/engine/core-modules/storage/upload-limits.ts:31`; `packages/rab-server/src/__tests__/integration/multipart-upload-security.integration.spec.ts` "acceptance 4/5: the configured file-size boundary is enforced — over-limit rejected, no new object written" | none |
| V12.1.2 | Compressed files checked against limits | N/A | No archive uploads (images and PDF only, `packages/rab-server/src/engine/core-modules/storage/file-kinds.ts:39`) | none |
| V12.1.3 | Per-user file quota and file count | partly | One file per request (`upload-limits.ts:31`); avatar replace tombstones the old file `packages/rab-server/src/__tests__/integration/staff-avatar-abuse-cases.integration.spec.ts` "replacing an avatar tombstones the old StoredFile row (status DELETED) and links the new one" | No per-user or per-organisation storage quota |
| V12.2.1 | Untrusted files validated by content type | met | Magic-byte sniffing `image-sniff.ts:26`; `multipart-upload-security.integration.spec.ts` "binary bytes with no valid image magic number are rejected by existing FileService validation, unaffected by the Multer upgrade" | none |
| V12.3.1 | Filename metadata not used by the filesystem | met | `multipart-upload-security.integration.spec.ts` "a malformed filename (path traversal attempt) never becomes storage path authority" | none |
| V12.3.2 | Filename validated against path traversal | met | `packages/rab-server/src/engine/core-modules/storage/safe-filename.ts:11` | none |
| V12.3.3 | Filename cannot trigger RFI or SSRF | met | Keys server-generated (V5.3.9 evidence) | none |
| V12.3.4 | Protection against reflective file download | met | `contentDisposition` with sanitised name `safe-filename.ts:34`; `files.controller.ts:212` | none |
| V12.3.5 | File metadata not passed to system APIs | met | No shell or filesystem call with file metadata in `packages/rab-server/src/engine/core-modules/storage` | none |
| V12.3.6 | No inclusion of untrusted remote code | met | Front CSP `script-src 'self'` `packages/rab-front/vercel.json:13` | none |
| V12.4.1 | Uploads stored outside web root, limited permissions | met | Private object storage via presigned URLs `file-storage-security.integration.spec.ts` "Internal Manager (owner workspace): 302 to a short-lived presigned URL that serves EXACTLY the stored bytes as an attachment" | none |
| V12.4.2 | Uploads scanned by antivirus | not met | none in `packages/rab-server/src/engine/core-modules/storage` | No AV scan; `rab-workforce-architecture.md:582` claims an AV hook that does not exist |
| V12.5.1 | Web tier serves only allowed file types | met | Files only via `files.controller.ts` with fixed kinds `file-kinds.ts:39` | none |
| V12.5.2 | Uploaded files never executed as HTML/JS | met | `X-Content-Type-Options: nosniff` `files.controller.ts:182`; CSP sandbox `files.controller.ts:213` | none |
| V12.6.1 | Outbound requests restricted to an allow list | partly | Outbound targets set only by env (providers, S3, OIDC) | No network egress allow list in `packages/rab-docker/docker-compose.production.yml` (default network has egress) |

### V13 API and web service

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V13.1.1 | Same encodings and parsers across components | met | JSON over HTTP everywhere | none |
| V13.1.3 | API URLs expose no sensitive information | met | Tokens in cookies or body (V3.1.1); presigned URLs never stored (V5.3.9) | none |
| V13.1.4 | Authorisation at URI and resource level | met | Route guard then service then RLS; `packages/rab-server/src/__tests__/integration/organisation-isolation.integration.spec.ts` "reads of Organisation 2 records by id are refused exactly like a non-existent id (404, or a categorical 403)" | none |
| V13.1.5 | Unexpected content types rejected | partly | Credential routes require JSON (415) `packages/rab-server/src/engine/core-modules/auth/guards/cookie-csrf.util.ts:50`; `login-csrf.integration.spec.ts` "text/plain and multipart bodies are refused the same way" | Other routes rely on the JSON body parser plus DTO validation, not an explicit 415 |
| V13.2.1 | HTTP methods valid for the action | met | Explicit method decorators per route, e.g. `auth.controller.ts:275` | none |
| V13.2.2 | Schema validation before accepting input | met | DTO validation globally `packages/rab-server/src/main.ts:92` | none |
| V13.2.3 | Cookie-using REST protected from CSRF | met | As V4.2.2 | none |
| V13.2.5 | Content-Type checked explicitly | partly | As V13.1.5 | As V13.1.5 |
| V13.2.6 | Headers and payload not modified in transit | partly | TLS at edge, HSTS | Not verified (infra) |
| V13.3.1 | XSD validation of XML | N/A | No SOAP or XML | none |
| V13.3.2 | WS-Security message signing | N/A | No SOAP | none |
| V13.4.1 | GraphQL query limits | N/A | No GraphQL server in `packages/rab-server/package.json` | Docs still describe GraphQL limits (`rab-workforce-architecture.md:610`) |
| V13.4.2 | GraphQL authorisation in business layer | N/A | No GraphQL server | none |

### V14 Configuration

| ID | requirement | status | evidence | gap |
| --- | --- | --- | --- | --- |
| V14.1.1 | Secure, repeatable, automated build and deploy | met | `.github/workflows/publish-image.yaml`; `.github/workflows/image-security-gate.yaml:177` | none |
| V14.1.2 | Compiler hardening flags | N/A | No project native code is compiled | none |
| V14.1.3 | Server configuration hardened | met | Helmet `packages/rab-server/src/main.ts:102`; container hardening `docker-compose.production.yml:774` | none |
| V14.1.4 | Redeployable from an automated process | met | Digest-pinned images and compose (`docker-compose.production.yml:574`) | none |
| V14.2.1 | Components up to date, dependency checker | met | `.github/workflows/ci-security.yaml:37`; image scan Trivy + Grype (`ci-security.yaml:299`) | npm updates not automated by Dependabot |
| V14.2.2 | Unneeded features and samples removed | met | Gate forbids dev packages in the image (`IMAGE_SECURITY_RELEASE_POLICY.md:55`); no Swagger in `packages/rab-server/src` | none |
| V14.2.3 | External assets use SRI | partly | Scripts are self-hosted | Google Fonts stylesheet without `integrity` `packages/rab-front/index.html:11` |
| V14.2.4 | Components from trusted, maintained repositories | met | Licence allow list `ci-security.yaml:58`; `yarn constraints` `ci-security.yaml:53` | none |
| V14.2.5 | SBOM maintained | met | `packages/rab-docker/docs/IMAGE_SECURITY_RELEASE_POLICY.md:151` | none |
| V14.2.6 | Third-party libraries sandboxed | met | PDF renderer thread guard `thread-guard.ts:13`; AI provider boundary `packages/rab-server/src/__tests__/static/ai-provider-boundary.spec.ts` | none |
| V14.3.2 | Debug modes disabled in production | met | `ENV NODE_ENV=production` `packages/rab-docker/rab/Dockerfile:161` | none |
| V14.3.3 | No version or component disclosure in headers | met | Helmet removes `X-Powered-By` (`main.ts:102`) | none |
| V14.4.1 | Content-Type with charset on every response | met | Express `res.json` sets `application/json; charset=utf-8`; files set explicit types `files.controller.ts:212` | none |
| V14.4.2 | API responses carry Content-Disposition attachment | not met | Only file routes set it (`files.controller.ts:212`) | JSON responses have none |
| V14.4.3 | Content Security Policy in place | partly | Front CSP `packages/rab-front/vercel.json:13`; API default Helmet CSP `main.ts:102` | Front CSP exists only for Vercel hosting; `style-src 'unsafe-inline'` |
| V14.4.4 | X-Content-Type-Options nosniff | met | Helmet `main.ts:102`; `vercel.json:15` | none |
| V14.4.5 | Strict-Transport-Security on all responses | met | Helmet default `main.ts:102`; `vercel.json:18` | Edge behaviour not verified (infra) |
| V14.4.6 | Suitable Referrer-Policy | met | `no-referrer` `vercel.json:17`; Helmet default | none |
| V14.4.7 | Framing restricted | met | `frame-ancestors 'none'` and `X-Frame-Options: DENY` `vercel.json:13`, `:16` | none |
| V14.5.1 | Only used HTTP methods accepted | met | Undeclared methods 404 (route table checked by `packages/rab-server/src/__tests__/integration/auth-route-inventory.integration.spec.ts` "discovers the real route table (sanity: the scan is not vacuous)") | none |
| V14.5.2 | Origin not used for authentication | met | Origin is an extra CSRF provenance check only (`cookie-csrf.util.ts:32`); authentication is the session | none |
| V14.5.3 | CORS origin allow list | met | `packages/rab-server/src/main.ts:115`; `packages/rab-server/src/__tests__/integration/origin-trust.integration.spec.ts` "CORS: the exact allowlisted origin gets ACAO; a workspace subdomain and a reserved sibling get none" | none |
| V14.5.4 | Proxy-added headers authenticated | met | `packages/rab-server/src/engine/utils/trusted-proxy.util.ts:66`; `rate-limiting.integration.spec.ts` "a spoofed multi-hop X-Forwarded-For does not let a client inject an arbitrary \"real\" IP" | none |

## 4. Gap list (ordered by risk)

### High

1. **V3.3.2 Session lifetime.** Missing: L2 needs re-authentication after 12 hours or 30 minutes idle. Manager web sessions last 180 days (30 days idle), mobile 90 days (7 days idle). Fix: `packages/rab-server/src/engine/core-modules/auth/session-policy.ts` (`ABSOLUTE_SESSION_TTL_MS`, idle map), which is an owner decision. Regression test: extend `profile-devices-sessions.integration.spec.ts` "policy: issuance stores the documented lifetimes ..." to assert the new ceilings, plus an idle-expiry denial after 30 minutes.
2. **V4.3.1 / V1.2.4 MFA not enforced for administrators.** Missing: `AUTH_MFA_ENFORCE_PLATFORM_ADMIN` and the owner/manager switches default to `false`; mobile is exempt. Fix: defaults in `packages/rab-server/src/engine/core-modules/environment/environment-variables.ts:1359` and `packages/rab-docker/docker-compose.production.yml:244`, or a production boot refusal. Regression test: in `mfa-totp-wave4.integration.spec.ts`, a production-config boot with the flag off is refused, and an un-enrolled platform admin gets the enrolment-required flow.

### Medium

3. **V2.1.1 / V2.1.7 / V2.1.9 Password policy.** Missing: 12-character minimum, breached-password check, and removal of the composition rule. Fix: `packages/rab-shared/src/utils/password.ts` (single source for server and UI). Regression test: `password.spec.ts` cases for an 11-character password refused, a 12-character lower-case passphrase accepted, a known breached password refused.
4. **V1.2.2 / V1.9.1 / V9.2.2 / V2.10.1 Redis unauthenticated and plaintext.** Missing: Redis ACL/password and TLS in `packages/rab-docker/docker-compose.production.yml:541`. Fix: mount the ACL already used in `docker-compose.image.yml`, use `rediss://` where the platform allows. Regression test: compose lint in `packages/rab-docker/staging` refusing a production `REDIS_URL` without credentials.
5. **V7.3.3 Audit log tamper resistance.** Missing: the owner login can re-grant UPDATE/DELETE on `audit_log` (G-05), and the external sink is best effort. Fix: deployment of an append-only sink (`packages/rab-server/src/engine/core-modules/audit-sink/security-audit-sink.ts`), plus a posture alarm on grant changes. Regression test: posture monitor turns `/healthz` unready when `audit_log` gains UPDATE for any role.
6. **V8.2.2 / V8.2.3 Staff notes in localStorage.** Missing: notes about staff are kept in the browser and survive logout and account switch. Fix: `packages/rab-front/src/features/users/UserProfile.tsx:110` (move to a server table with RLS, or remove) and a logout cleanup in the auth feature. Regression test: front spec asserting no `user-notes-*` key exists after logout.
7. **V8.3.2 / V8.3.3 Privacy rights and notice.** Missing: self-service export/erasure request and a real privacy notice. Fix: `packages/rab-server/src/modules/identity` (export and erasure-request endpoints) and `packages/rab-website/app/[legal]/page.tsx`. Regression test: integration test that a user's export contains only their own rows and that cross-tenant ids return 404.
8. **V8.1.1 / V8.2.1 No anti-caching header on API.** Missing: `Cache-Control: no-store` on authenticated JSON. Fix: one middleware in `packages/rab-server/src/app.module.ts` or `main.ts`. Regression test: HTTP spec asserting `no-store` on `GET /auth/me`.
9. **V3.4.3 / V3.4.4 Cookie hardening off by default.** Missing: `__Host-` prefix default off; `SameSite=None` in production. Fix: default in `environment-variables.ts:298` and `docker-compose.production.yml:198`. Regression test: existing `auth-cookie-policy.spec.ts` plus an env test that production defaults to host mode.
10. **V2.1.5 / V2.1.6 No voluntary password change.** Missing: an endpoint that requires the current password. Fix: `packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts` and `auth.controller.ts`. Regression test: wrong current password returns 401 and changes nothing; success revokes other sessions and sends the notice email.
11. **V7.2.2 Authorisation failures not logged.** Missing: `PermissionGuard` 403s leave no record. Fix: `packages/rab-server/src/engine/guards/permission.guard.ts:43` (rate-limited security event). Regression test: a 403 produces one `access_denied` event with flag and route template, no body.
12. **V11.1.8 / V11.1.7 / V8.1.4 No alerting.** Missing: alerts on attack patterns (429 bursts, refresh-token reuse, MFA failures). Fix: shipped security events in `packages/rab-server/src/engine/core-modules/audit-events` and the deployment's log pipeline. Regression test: unit test that a reuse detection event is classified `critical` and shipped.
13. **V4.3.3 Payroll approval without step-up.** Missing: recent re-authentication for payroll approve and export. Fix: `packages/rab-server/src/modules/payroll/services` calling `StepUpReauthService.assertRecentStepUp`. Regression test: stale session gets 403 `STEP_UP_REQUIRED`, writes nothing.
14. **V6.1.1 / V6.1.3 Personal data not encrypted at field level.** Missing: field encryption or verified volume encryption for date of birth, phone, emergency contact; doc drift on bank/NI fields. Fix: `packages/rab-server/src/modules/staff/entities/staff-profile.entity.ts` or a documented infra control; correct `rab-workforce-architecture.md:580`. Regression test: raw SQL read returns ciphertext for those columns.
15. **V8.3.8 / V1.8.x Retention and classification.** Missing: enforcement jobs and a classification register. Fix: Worker job under `packages/rab-worker/src` plus a register in `rab-workforce-architecture.md:586`. Regression test: job anonymises PII older than the policy window and keeps financial rows.
16. **V12.4.2 No antivirus scan.** Missing: AV scanning of uploads (payslip PDFs especially). Fix: `packages/rab-server/src/engine/core-modules/storage/file.service.ts`, or correct the architecture claim at `rab-workforce-architecture.md:582`. Regression test: EICAR test file is rejected.

### Low

17. **V3.3.4** Revoke-other-sessions needs no re-auth. Fix: step-up in `packages/rab-server/src/modules/identity/services` for `DELETE /profile/sessions`. Test: stale session gets 403.
18. **V2.3.2** No FIDO2/WebAuthn. Fix: new factor in `packages/rab-server/src/engine/core-modules/auth/mfa`. Test: registration and assertion with a virtual authenticator.
19. **V2.4.5** No pepper. Fix: keyed step in `password-hashing.service.ts` with keyring rotation. Test: hash differs with a different pepper kid; verify still works after rotation.
20. **V2.6.2** Recovery codes 80 bits, unsalted. Fix: lengthen codes or add per-code salt in `recovery-codes.ts`. Test: generated code entropy at least 112 bits.
21. **V2.8.5** TOTP replay not reported. Fix: distinct audit action and notice in `mfa-challenge.service.ts`. Test: replay produces `mfa_code_replayed` event.
22. **V2.3.1 / V8.3.1** 48-hour reset tokens in query strings. Fix: shorter TTL for self-service reset in `password-reset-token.service.ts`; token in fragment. Test: token older than TTL refused.
23. **V14.4.2** No `Content-Disposition` on JSON. Fix: middleware in `main.ts`. Test: header present on `GET /auth/me`.
24. **V14.2.3** Google Fonts without SRI. Fix: self-host fonts in `packages/rab-front`. Test: `index.html` has no third-party stylesheet.
25. **V14.4.3** CSP only in `vercel.json`, `unsafe-inline` styles. Fix: edge config for the Cloudflare deployment. Test: header check in the e2e suite.
26. **V9.2.4** No revocation checking. Fix: accept as platform limitation or use OCSP stapling at the edge. Test: none practical; document.
27. **V6.4.1 / V6.4.2** No vault/HSM. Fix: KMS-backed keyring loader in `packages/rab-server/src/engine/core-modules/secret-encryption`. Test: boot refuses plaintext keys when KMS mode is required.
28. **V12.1.3** No storage quota. Fix: per-organisation byte quota in `file.service.ts`. Test: upload over quota rejected.
29. **V12.6.1** No egress allow list. Fix: network policy or egress proxy in deploy. Test: compose lint.
30. **V13.1.5 / V13.2.5** No global content-type check. Fix: middleware returning 415 for non-JSON bodies on JSON routes. Test: `text/plain` body to a write route gets 415.
31. **V7.1.2** Deleted user email in audit metadata. Fix: `UserDeletionService` in `packages/rab-server/src/engine/core-modules/user-deletion`. Test: deletion audit row has no email.
32. **V7.3.1 / V1.7.1** Logger format. Fix: JSON console logger in `main.ts`. Test: log line with CR/LF in a message is one JSON line.
33. **V8.3.5** Personal-data reads not audited. Fix: audit read of staff profile detail. Test: read writes one audit row.
34. **V2.1.8** No strength meter. Fix: `packages/rab-front/src/features/auth`. Test: component spec.
35. **V5.1.1** No HPP test. Fix: none needed in code. Test: duplicate query keys return 400.
36. **V11.1.2 / V11.1.3** Business limits not verified. Fix: implement the cost classes in `rab-workforce-architecture.md:599` or correct the doc. Test: per-class 429.
37. **V8.1.2 / V8.3.6** Cache expiry and memory hygiene unverified. Fix: TTL assertion on all Redis keys. Test: every auth-cache key has a TTL.
38. **V1.14.5** OpenShip drops container hardening. Fix: deploy only on supported targets. Test: existing compose preflight.
39. **V9.1.x / V7.3.4 / V10.3.3 / V13.2.6 / V1.7.2 / V2.10.3** Infra controls not verified. Fix: record edge TLS policy, NTP, DNS and log shipping in deploy docs. Test: TLS scan in release checklist.

## 5. Proposed issues for the lead

Not opened. Titles only.

- `security(asvs V3.3.2): shorten manager and mobile session lifetimes to the L2 re-authentication bound`
- `security(asvs V4.3.1): enforce MFA for platform administrators and organisation owners by default`
- `security(asvs V2.1.1): raise minimum password length to 12, drop composition rule, add breached-password check`
- `security(asvs V1.2.2): require Redis authentication and TLS in the production compose`
- `security(asvs V7.3.3): make audit log tamper-evident under the owner login (append-only sink and grant alarm)`
- `security(asvs V8.2.3): stop storing staff notes in localStorage and clear client storage on logout`
- `security(asvs V8.3.2): add self-service data export and erasure request`
- `docs(asvs V8.3.3): publish the approved privacy notice before launch`
- `security(asvs V8.2.1): send Cache-Control no-store on authenticated API responses`
- `security(asvs V3.4.4): default __Host- cookies on in production`
- `feat(asvs V2.1.6): voluntary password change that requires the current password`
- `security(asvs V7.2.2): log authorisation failures from PermissionGuard`
- `security(asvs V11.1.8): alert on attack patterns from shipped security events`
- `security(asvs V4.3.3): require step-up for payroll approval and export`
- `security(asvs V6.1.1): encrypt staff personal data at rest or document the volume-encryption control`
- `chore(asvs V8.3.8): implement retention enforcement job and data classification register`
- `security(asvs V12.4.2): add antivirus scanning for uploads, or correct the architecture claim`
- `security(asvs V3.3.4): require re-authentication to revoke other sessions`
- `feat(asvs V2.3.2): support WebAuthn/FIDO2 as a second factor`
- `security(asvs V2.4.5): add a keyed pepper step to password hashing`
- `security(asvs V2.6.2): raise recovery-code entropy to 112 bits`
- `security(asvs V2.8.5): report TOTP replay attempts to the user`
- `security(asvs V2.3.1): shorten password-reset token lifetime`
- `chore(asvs V14.2.3): self-host web fonts`
- `docs(asvs V13.4.1): remove stale GraphQL and AV claims from rab-workforce-architecture.md`

## 6. Notes on assumptions

- **Edge TLS (V9.1.1 to V9.1.3, V13.2.6, V14.4.5).** TLS for browsers and the mobile app ends at the edge: Vercel for the front (`packages/rab-front/vercel.json`), and a Cloudflare Tunnel is the recommended path for the API (`packages/rab-docker/docs/release/OWNER-LOGIN-ORACLE-VM-PLAN.md:49`). Cipher suites, protocol versions and certificate handling there are not in the repo and were not verified.
- **Container hardening (V1.14.5).** The supported compose sets non-root users, read-only roots and dropped capabilities, but OpenShip drops those keys (`packages/rab-docker/docker-compose.production.yml:19`). Status assumes a supported target.
- **Log shipping and tamper evidence (V1.7.2, V7.3.3).** Production requires an audit sink, but shipping `stdout` off-host to append-only storage is a deployment dependency (`packages/rab-server/src/engine/core-modules/audit-sink/security-audit-sink.ts:13`).
- **Database TLS.** Verified in code (verify-full refusal rules at `packages/rab-server/src/database/boot-checks/database-boot-gate-rules.ts:591`) and documented in `packages/rab-docker/docs/release/OWNER-LOGIN-DEPLOYMENT.md:125` and `packages/rab-docker/docs/phase-d-deployment-runbook.md:140`.
- **Disk and volume encryption (V6.1.1, V6.1.3).** Not visible in the repo. If the managed database or volume is encrypted at rest, these items could move to `met` for the "at rest" wording, but not for field-level protection.
- **Time sync (V7.3.4), DNS (V10.3.3), secret storage (V2.10.3, V6.4.1).** Host and platform concerns; not verified.
- **Rate-limit store.** Login and MFA limiters fail closed when Redis is down (`packages/rab-server/src/__tests__/integration/throttler-redis-outage.integration.spec.ts` "login, refresh and password recovery fail closed with 503 within bounded time, and set no cookie"); this was counted in V2.2.1.
- **Documentation drift.** `rab-workforce-architecture.md` claims controls the code does not have: encryption of sort code, account number and NI number (`:580`), an upload AV hook (`:582`), a logging interceptor naming those fields (`:584`), double-submit CSRF with `SameSite=Strict` (`:595`), GraphQL limits (`:610`) and mobile certificate pinning (`:622`). The review followed the code. `SECURITY.md:188` lists MFA and cookie hardening as known gaps, which matches the findings above.
- **Tests not run.** Every test title was read from the spec file at this commit; none was executed in this review.
- **Requirement IDs.** ASVS 4.0.3 has gaps in its numbering (for example V4.1.4, V5.1.6 and V7.3.2 do not exist, and V6.2.7, V9.2.5 are L3 only). Those are deliberately absent from the tables.
