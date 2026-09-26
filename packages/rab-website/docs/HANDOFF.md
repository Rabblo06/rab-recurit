# Website handoff — 2026-09-25

## Location and isolation

The user moved the project into `C:/Rab-recruit/packages/rab-website`; this is the authoritative path. The former root directory is absent. README image assets also moved to `packages/rab-readme`, and the repository README links/tree were corrected. This package is independent of the Yarn/Nx SaaS workspace, with its own npm manifest/lock and no SaaS imports or env files.

## Architecture and design

Next.js App Router, React, TypeScript, Tailwind 4; shadcn-compatible `components/ui`, Radix mobile Sheet and Lucide icons. Mostly server components; small client islands for Sheet, sector pause, pointer tilt, reveal observers and contact options. Warm ivory, burgundy, muted rose/sand, dark green-black. System sans plus Georgia editorial italic avoids font fetch/layout shift. Proposed original wordmark and illustrations; the user-supplied local hospitality photograph is now used in the second section; no invented people, copied OpenShip assets, statistics or quotes.

OpenShip screenshot/brief informed whitespace, floating nav, entrance hierarchy, dimensional cards and dark/light pacing only. The three text attachments are identical. No reference video or hero-01 source was actually supplied, so frame-by-frame reference comparison is unavailable. See motion-reference.md.

## Components and content

`app/` owns routes /, /jobs, /contact, /privacy, /cookies, /terms, 404, robots and sitemap. `components/sections` contains Hero, SectorMarquee, RecruitmentStack, RecruitmentFlow, editorial content sections, footer and contact options. `components/shared` owns navigation and MotionReveal/SectionHeading. `styles/globals.css` centralizes design/motion tokens. `lib/site.ts` centralizes public details; `data/jobs.ts` stores inactive role examples and future active listing fields.

Content evidence and sources: content-audit.md. Indexed company pages support London, permanent/interim/temporary recruitment, personal consultants, hospitality/events, office/finance, IT/media, healthcare and education. No dated vacancy treated as active. Contact by telephone and hospitality CV mailto only; no fake submission. EmploymentAgency schema only, no fabricated JobPosting. Legal pages explicitly pending approval/noindex. Testimonial placeholder only in development.

## Motion and accessibility

One marquee with pause button/hover pause, hero reveals/glow, native one-shot IntersectionObservers with cleanup, desktop pointer tilt and progressive CSS view-timeline depth, sticky desktop workflow heading and drawing connectors. Mobile stacks cards, removes perspective and sticky flow. Reduced-motion renders final states immediately. No-JS content remains visible. Radix manages menu focus trap, Escape and restoration; footer navigation is the no-JS mobile fallback.

First QA detected fixed wordmark contrast over dark sections and two pale text colors. Fixed with a stable wordmark surface and darker text. Candidate contact links now initialize the candidate radio from the URL. Social preview includes PNG for crawler compatibility.

## Commands and verification

From this directory: npm ci --workspaces=false; npm run dev (3100); npm run build; npm start; npm run lint; npm run typecheck. With production server running: npm test; node tests/performance.mjs. Tests use installed Google Chrome. QA artifacts in qa/. Final measured results are recorded in REBUILD-REPORT.md and qa/results.json / qa/performance-summary.json.

## Release status and next actions

Local preview only, no deployment or changes to production infrastructure. Obtain approved legal text, confirm current contact details/sector services, approve proposed branding/copy and verify job records before public launch. Missing reference video/source would enable precise comparison. No field INP claim; Lighthouse is lab evidence only. Future API/CMS/contact form must be separate explicit work. Do not wire this to RAB SaaS by default.

Final local measurements: Lighthouse mobile simulation 99 Performance / 100 Accessibility / 100 Best Practices / 100 SEO; LCP 2.2s, CLS 0, TBT 20ms. Production build, lint and TypeScript pass. Four viewport browser checks passed with zero axe WCAG violations; heading-order correction independently verified by final Lighthouse. Continuous scroll recording is 10.84s with 16 extracted sample frames reviewed. No field INP measurement or exact missing-video comparison is claimed. See docs/REBUILD-REPORT.md and qa artifacts. Local production server runs on port 3100; no public release performed.


## Second-section redesign ? 2026-09-25

Current source of truth: user attachment b1aefbe0-7221-4aed-a7c1-7cba447236cd explicitly requests implementation inside this existing package. Retained RecruitmentStack export and homepage placement; hero, header, routes, global design tokens and dependencies unchanged. Replaced its old illustration with four editorial cards, a statement and sector links. CSS is isolated in recruitment-stack.module.css; cards are grouped in recruitment-cards.tsx; use-recruitment-motion.ts owns cleanup, one-shot entrances and event-driven depth. Existing unused global stack selectors are left intact to avoid unrelated cleanup.

Image: image/hero.jpg, 930?620, user-supplied ballroom/restaurant photograph, statically imported with Next/Image, lazy loaded and cropped with object-fit cover. Do not replace it with stock imagery. The supplied PDF has 17 still-image pages and informs card depth/composition; it cannot establish animation timing. Motion follows the user's written sequence. No actual reference video was available.

Desktop: staggered assembly, small differential parallax, fine mouse-only pointer depth, bounded exit scale/opacity. Tablet simplifies rotations and removes parallax. Mobile stacks image/employer/candidate/spotlight, then statement/navigation. Reduced motion and no-JS show final content. No new dependency, React scroll state, permanent RAF loop or scroll trapping.

Verification: lint, typecheck, production build, existing npm test and node tests/recruitment-story.mjs passed. Eight requested viewports (1920,1440,1280,1024,768,430,390,375 widths), no horizontal overflow, local image decode/crop, mobile ordering, header layering, links, touch isolation, reduced motion and no-JS verified; zero tested axe violations or browser warnings/errors. node tests/recruitment-motion.mjs passed: desktop pointer/reset and bounded exit verified, 9.08s local recording with 20 sampled frames inspected, observed layout-shift sum 0. These are local Chrome checks, not field performance guarantees. Earlier Lighthouse scores above predate this redesign and were not rerun.

Evidence and full file inventory: docs/RECRUITMENT-STORY-REPORT.md and qa/recruitment-story/. Viewport captures retain the header; section-only captures hide the fixed header/skip link solely during capture to avoid full-element screenshot artifacts. No production deployment. Sector links go to existing /contact?sector=...; contact currently does not preselect or display that sector parameter. Hospitality is visually featured, not a pretend tab switcher. Next action: review local preview and approve the composition; resolve existing site-wide legal/contact/branding release approvals before publishing.
