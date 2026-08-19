# Security

## Reporting a vulnerability

Please report security issues privately — not as a public GitHub issue.

- Preferred: use GitHub's [private vulnerability reporting](../../security/advisories/new) for this repo (Settings → Security → "Report a vulnerability" — enable it if you don't see this link yet).
- Fallback: email sebastiansiju1804@gmail.com with subject `SECURITY: rab-recurit`.

Use the finding format from `rab-workforce-architecture.md` §5.8: severity, actor → action → consequence, file:line, root cause, fix, regression test. Never write "consider improving security" in place of a finding.

**Response time:** we aim to acknowledge reports within 3 business days and provide an initial assessment (valid/invalid, severity) within 7.

## Supported versions

This project is pre-v1 (milestone M0) — there is no released/tagged version yet, so only `main` is supported. A versions table will be added once releases start.

## Secrets in this system

| Secret | Used for | Rotation |
|---|---|---|
| `APP_SECRET` | `SecretEncryptionService` (bank details, NI numbers) once built (M1); token signing | Rotating it invalidates every encrypted-at-rest value encrypted under the old key and every signed token. Requires a re-encryption migration (decrypt under old key, re-encrypt under new) run before the old key is removed from the environment — never rotate by simply swapping the env var. |
| `rab_owner` / `rab_app` DB passwords | Migration runner (`rab_owner`) and the running server (`rab_app`) — see §5.7 | Rotate via `ALTER ROLE ... PASSWORD ...`, update the corresponding connection string in the deploy environment, redeploy. `rab_app`'s password can rotate independently of `rab_owner`'s — they're separate credentials by design. |
| `SENTRY_DSN` | Error reporting | Low sensitivity (write-only ingestion key); rotate via the Sentry project settings if leaked, no data-migration impact. |
| S3/R2 credentials (M1+, file storage) | Document/payslip storage | Rotate via the provider console; presigned URLs already in flight (60s TTL) expire naturally, no in-place migration needed. |

Nothing above is ever committed. `.env.example` at each package root carries variable names only, never values. `gitleaks` runs in `ci-security.yaml` and blocks merge on a detected secret.

## What's covered so far

- Row-Level Security foundation (`rab-workforce-architecture.md` §5.7): `rab_owner`/`rab_app` role split, session-context functions, `check-rls-coverage` CI gate. No tenant tables exist yet (M0) — the gate currently passes trivially and starts doing real work the moment M1 lands the first one.
- Env validation fails closed on boot (missing `APP_SECRET`, `DATABASE_URL`, or `REDIS_URL` refuses to start rather than run insecurely).

## What's not built yet

Authentication, authorisation guards, audit logging, rate limiting, and the abuse-case test suite land in M1 onward per `rab-workforce-architecture.md` §14. This file gets a new row and a new "covered so far" bullet in the same PR each of those lands, not after.
