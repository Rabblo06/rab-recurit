# Documentation review — validation results, limitations and outstanding work

Review date: 2026-10-13. Branch `docs/crewflow-docs-site` (from `main` at `1993562e`). Mintlify CLI `mint@4.2.1018`, Node 24.12.

## Summary

| Item | Result |
| --- | --- |
| Pages | **102** MDX pages in 5 tabs (Get started 14, User guide 51, Mobile app 15, Security 5, Developers 17) |
| API reference | 191 endpoints from 29 controllers, generated from source (no OpenAPI exists) |
| Real product screenshots | **95** — 60 web console, 32 Android app captures, 3 Flutter golden renders |
| Other imagery | 14 overview/feature composites (from the README, real UI), 3 brand assets, 13 video posters |
| Playable tutorial videos | **13** H.264 MP4s (10 web at 1600×900, 3 mobile at 720×1760), 9.8 MB total, all with burned-in captions and title cards |
| Media not captured | 1 — the clock-in/clock-out recording, flagged with a labelled notice on `attendance/clock-in-and-out` and `mobile/clock-in-and-out` (see Limitations) |

## Validation results

| Check | Command | Result |
| --- | --- | --- |
| Configuration and MDX compilation | `mint validate` | **Pass** — "build validation passed" |
| Internal links, anchors, snippets | `mint broken-links --check-anchors --check-snippets` | **Pass** — no broken links |
| Accessibility | `mint a11y` | **Pass** for content (all 102 files: images and videos have alt text). Colours: all pass WCAG AA (`#79543A` 6.68:1, `#D97A52` 6.41:1 on dark, `#9C6C4D` 4.50:1 / 4.36:1); the tool suggests AAA as an optional improvement. |
| Missing images and videos | `tools/check-docs.cjs` | **Pass** — 87/87 image references and 13/13 video references exist |
| Video playability | `tools/check-docs.cjs` with `FFMPEG` | **Pass** — every video decodes without errors, H.264, under 20 MB each (largest 1.05 MB) |
| Duplicate pages / titles | `tools/check-docs.cjs` | **Pass** (one duplicate title found and fixed during review) |
| Navigation | `tools/check-docs.cjs` | **Pass** — 102 navigation entries, every entry has a file, no orphan pages |
| Public-content security | `tools/check-docs.cjs` + manual review | **Pass** — no connection strings, keys, personal emails, internal paths (`.audit/`, `docs/HANDOFF`) or incident details on public pages; environment variables listed by name only |
| Desktop, tablet and phone layouts, light and dark | `tools/screenshot-docs.cjs` (11 pages × 3 widths × 2 themes = 66 views) | **Pass** — no horizontal overflow, no broken images, no page errors, no video errors |
| Rendered review | Manual inspection of preview screenshots | Hero, navigation, tabs, TOC, frames, phone grids, video players and Mermaid diagrams render correctly |

Preview screenshots of the finished site are in `internal/preview/`.

## Corrections made during review

- Hover buttons (not row menus) on Users, Shifts and Offers tables — wording and alt text fixed on six pages.
- New-shift result shows partial sends with the server's real overlap message — page now explains it.
- Staff decline reasons removed from demo data: the staff app cannot send one, so screenshots must not show one.
- Organisation suspension has no web UI — page changed from instructions to an operations note.
- Admin Panel SMTP settings do not drive email delivery — warning added and the administrator quick start no longer relies on them.
- Venue "Paid" breaks are not applied to pay — warnings added on the venue, attendance and pay pages.
- Staff "Deactivate" actually sets employment to inactive and suspends the account — documented precisely.
- Portrait video captions moved into a band below the phone screen so they never cover app buttons.
- A frame-timing bug in the video composer that stretched recordings ~1.5× (desynchronising captions) was fixed before publishing.

## Known limitations

| Limitation | Detail |
| --- | --- |
| Clock-in/out recording | The emulator's camera cannot be shown a QR code from the command line, so a full clock-in could not be recorded. The page shows real still renders (emulator capture for "Ready to clock in", location and scanner; Flutter goldens for live, confirm and completed) and a clearly labelled "Media not yet captured" notice. |
| Fixture-driven media | All captures use the real interfaces with synthetic API responses (`tools/web/fixtures.cjs`, `tools/mobile-fixture-server.cjs`). The fixtures mirror server rules (pipeline stages, status labels, overlap checks), but they are not the live backend. |
| Mixed demo data on one page | The clock page combines emulator captures ("Harbour Exhibition Centre") with Flutter goldens ("Example Hotel"); both are fictional. |
| Status bar time | Mobile captures show a pinned 09:41 status bar while in-app times use the real clock. |
| Local search | `mint dev` only enables search after `mint login`; search works on the deployed site. |
| Feedback controls | Thumbs/feedback are enabled in the Mintlify dashboard (Pro/Enterprise), not in `docs.json`. Not yet configured. |
| Brand name in the product | The product still shows "RAB Recruitment" (browser title, PWA manifest, timesheet PDF header) and "ADOLPHUS" (mobile onboarding, activation success). The docs use **Crewflow**, quoting product labels verbatim where users will see them. |

## Product issues found while documenting (not fixed — documentation only)

See `CONTENT_AUDIT.md` → *Known product defects*. Highlights for the product owner:

1. `Venue.breakPaid` is stored but never used in pay calculations.
2. Admin Panel SMTP configuration is not used by the email driver.
3. `MANAGER_CONFIRMATION_TIMEOUT_MINUTES` comment says auto-reject; the job auto-confirms.
4. Mobile notifications show UTC times (`createdAt` without `.toLocal()`), one hour early during BST.
5. Mobile real-time and push services are never started, so the app relies on 30-second polling.
6. "Set up Biometric Login" sheet can render blank on slow devices (animation race in `auth_flow_shell.dart`).
7. Staff Home "N confirmed" count includes past shifts.
8. Venue manager shift report "Scheduled" row shows `?` between times.
9. `/users/:id` legacy page calls a non-existent endpoint; several settings routes are unlinked.
10. Final timesheet PDF prints raw UTC ISO timestamps and the "RAB Recruitment" title.

## Outstanding work before public release

1. **Owner review** of every page for tone and business accuracy, especially the role matrix, pay rules and product-status page.
2. **Decide the public support contact.** No support email exists in the repository; `support/contact.mdx` routes people to their organisation and to the GitHub security policy only.
3. **Record the clock-in/out tutorial** on a physical Android device (see `tools/MOBILE_CAPTURE.md`) and replace the `CapturePending` notice in `attendance/clock-in-and-out.mdx` and `mobile/clock-in-and-out.mdx`.
4. **Connect Mintlify** (GitHub App, monorepo path `/packages/crewflow-docs`), enable feedback, and configure the custom domain — see `DOCS_DEVELOPMENT.md`. Requires owner authorisation.
5. **Confirm the web console URL** (`https://app.rabworkspaceteams.co.uk`, verified responding on 2026-10-13) is the one to publish.
6. Re-capture media after any product rebrand (browser title, PDF header, mobile onboarding) so screenshots show final branding.
7. Re-run the full validation suite after any product release that changes labels, roles, timings or pay rules (`CONTENT_MAINTENANCE.md`).
