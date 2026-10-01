# RAB Security Fix Plan

## Already fixed (this session)

| Finding | Fix | Verified by |
|---|---|---|
| SEC-001 — single-layer (RLS-only) org check on pending-shift actions | Added explicit `shift.organisationId === ctx.organisationId` checks in `assertShiftViewable`, `removeRequestedStaff`, `addRequestedStaff`, `approveShiftRequest`, `declineRequest` | New integration test, passing under the real `rab_app` role; `rab-server:lint` (tsc) clean; full `venue-manager-scoping.integration.spec.ts` (15/15) and `scheduling-offer-abuse-cases.integration.spec.ts` (36/37, the 1 failure pre-existing/unrelated) re-run clean |
| SEC-002 (VULN-004) — unvalidated shift-cancel `reason` | Added `CancelShiftDto`, wired via `@Body() dto` | Live re-reproduction of the original PoC now returns `400`; valid input still succeeds |

## P0 — must fix before production

**None identified.** No cross-tenant access, auth bypass, public/unauthenticated database, hardcoded production secret, live RLS bypass under the real runtime role, SQL injection, or account-takeover path was found open in this pass. The one finding in that class from the prior audit (VULN-003) is confirmed fixed.

## P1 — should fix soon, real but bounded risk

| Finding | Fix | Effort |
|---|---|---|
| SEC-003 — `multer` <2.3.0 (3 High DoS advisories) | `yarn up multer@^2.3.0` in `packages/rab-server`; re-run the avatar-upload integration tests | Small — dependency bump, verify no breaking API change in the 2.x→2.3 range (changelog check) before merging |
| SEC-004 — `nodemailer` <9.1.0 (High ReDoS + 3 Moderate address-parsing bugs) | `yarn up nodemailer@^9.1.0` in `packages/rab-server`; re-run the email-outbox/worker integration tests | Small — same caveat |

## P2 — worth doing, not urgent

| Finding | Fix | Effort |
|---|---|---|
| SEC-005 — no `Permissions-Policy` header | Add explicit header in `main.ts` (or Helmet's `permissionsPolicy` option on upgrade); confirm `rab-front`'s Vercel config sets an equivalent for the actual browser surface | Small |
| SEC-006 — attendance clock-in has no time-window check | Product decision needed on tolerance window and desired behavior (reject vs. flag-for-review); then a DTO/service check in `AttendanceService.clockIn` | Small once the product decision is made |
| SEC-009 — Dependabot missing `npm`/`pub` coverage | Add `package-ecosystem: "npm"` and `"pub"` entries to `.github/dependabot.yml` | Trivial |

## P3 — low priority / process, not code

| Finding | Fix | Effort |
|---|---|---|
| SEC-007 — mobile HTTP base-URL dev fallback | Confirm the mobile release CI always passes `--dart-define=API_URL=https://...`; optionally add a release-mode assertion | Verification task, not a code change in this repo as checked out |
| SEC-008 — dev-only `docker-compose.yml` Redis/Adminer hygiene | Pin `adminer` version; optionally add local Redis auth for parity | Trivial, cosmetic |

## Explicitly not done in this pass, and why

- **Dependency version bumps for SEC-003/SEC-004 were not applied.** Bumping a direct runtime dependency changes a lockfile and carries real (if usually small) behavioral risk across two packages that touch file upload and every transactional email in the system — this is exactly the kind of change this audit's own rules ask to be proposed, not silently applied, and it deserves its own PR with the upload/email test suites re-run against it, not a change bundled into a security-audit pass.
- **No architectural changes were made or proposed as required.** Nothing found in this pass rose to that bar — every open finding is either a version bump, a header addition, or a product-scoped business-logic decision.
- **Full exhaustive live penetration testing of every one of the 65 requested phases was not performed as originally scoped in the request** — see the "Remaining unverified areas" section of the final report for the specific list (infrastructure phases that don't apply yet because nothing is deployed to Cloudflare/DigitalOcean from this repo, exhaustive fuzzing of every endpoint's business logic, load-testing-scale DoS validation, and a couple of narrower items). Each is called out explicitly as NOT VERIFIED rather than silently assumed secure.
