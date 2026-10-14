# Keeping the documentation aligned with the code

The documentation describes the real system. It drifts the moment a label, rule or default changes without a matching docs change. This guide says what to update and when.

## The golden rules

1. **Never document a feature before it is reachable by users.** Unfinished work goes on `getting-started/product-status.mdx` only.
2. **Quote the UI exactly.** Button and field labels in **bold** must match the code. Search the client source for the old label when you change one.
3. **Numbers come from code, not memory.** Every duration, limit and default on the site appears in `internal/CONTENT_AUDIT.md` with its source file.
4. **No secrets, ever.** Environment variable *names* are fine; values are not. No personal addresses, internal hostnames, incident details or `.audit/` / `docs/HANDOFF.md` references on public pages. `tools/check-docs.cjs` enforces part of this.
5. **Media is real or clearly pending.** Screenshots and videos come from the real interfaces with synthetic data. If something cannot be captured, use `<CapturePending>` and record a capture task in `MEDIA_MANIFEST.md` — never a mock-up passed off as the product.

## What to update when code changes

| If you change… | Update |
| --- | --- |
| A web console label, page or route (`packages/rab-front/src/features/**`) | The matching user-guide page; re-capture its screenshot (`tools/web/capture-screens.cjs`). |
| A mobile label or screen (`packages/rab-mobile/lib/features/**`) | The `mobile/` page; re-capture via `tools/MOBILE_CAPTURE.md`. |
| A controller route, guard or permission flag | Re-run `tools/generate-api-reference.cjs`; review `getting-started/user-roles.mdx` and `account/roles-and-permissions.mdx`. |
| A role's permissions (`ROLE_DEFS` in `manager.service.ts`, staff permissions in `staff.service.ts`) | The role matrix in `getting-started/user-roles.mdx`. |
| A state machine (`packages/rab-shared/src/state/*`) | `shifts/overview.mdx`, `shifts/status-reference.mdx`, `staff/account-states.mdx`, `attendance/attendance-history.mdx`. |
| An environment default (`environment-variables.ts`) — expiry, grace periods, windows | `developers/environment-configuration.mdx` and every user page quoting the value (search for the number). |
| Session lifetimes (`session-policy.ts`) | `account/signing-in.mdx`, `account/sessions-and-devices.mdx`, `security/authentication-and-sessions.mdx`, `developers/authentication-flow.mdx`. |
| Worker jobs or intervals (`packages/rab-worker/src/main.ts`) | `notifications/automation.mdx`, `developers/background-jobs.mdx`. |
| Pay rules (`duration.ts`, rate resolution, break handling) | `payroll/pay-calculation.mdx`, `venues/pay-rates.mdx`, `venues/geofence-and-breaks.mdx`. |
| A feature moves from in development to available | Remove it from `product-status.mdx`, write or extend the user guide, add media. |
| A known defect is fixed (see `CONTENT_AUDIT.md` → Known product defects) | Remove the corresponding warning (for example paid breaks, Admin Panel SMTP). |

## Values worth searching for

These appear on several pages. Search the docs before changing them in code:

`48 hours` (offer expiry) · `60 minutes` (confirmation window) · `15 minutes` (clock-in opens; pipeline cancel cut-off) · `2 hours` (clock window after end) · `10 minutes` (late) · `30 minutes` (no-show; missing clock-out; web idle) · `24 hours` (invitation validity; web session) · `90 days` (mobile session; biometric re-auth) · `7 days` (mobile idle; invite clean-up) · `200` / `50` / `100` metres (geofence) · `10 MB` / `20 MB` (uploads) · `10–128 characters` (passwords).

## Review checklist for a docs pull request

- [ ] `mint validate` passes.
- [ ] `mint broken-links --check-anchors --check-snippets` passes.
- [ ] `node tools/check-docs.cjs` passes (with `FFMPEG` set if videos changed).
- [ ] Every new statement about behaviour cites a file in `CONTENT_AUDIT.md`.
- [ ] New or changed screenshots use synthetic data and are listed in `MEDIA_MANIFEST.md`.
- [ ] No unfinished feature is described as available.
- [ ] British English; UI labels match the code exactly.

## Ownership

Product changes and documentation changes should land in the same pull request where possible. When they cannot, open a follow-up issue linking both and add the gap to `DOCS_REVIEW.md` → Outstanding work.
