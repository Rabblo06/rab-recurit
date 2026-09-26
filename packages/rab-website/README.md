# Adolphus Group website

Independent public recruitment website at `packages/rab-website/`. It does not import or call the RAB SaaS, and does not read its environment files.

## Run

Use Node 24 and run commands **in this directory**:

```sh
cd packages/rab-website
npm ci --workspaces=false
npm run dev
```

Open http://localhost:3100. Production: `npm run build`, then `npm start`. Checks: `npm run lint`, `npm run typecheck`. With the production server running, `npm test` runs local Chrome/Playwright and axe. `node tests/performance.mjs` runs Lighthouse. Chrome must be installed. Screenshots/results are in `qa/`; recordings are in `qa/video/`.

This package intentionally has its own npm lockfile and node_modules. The parent repository uses Yarn, but this separate marketing site is not enrolled in the SaaS workspaces. No shared package or lockfile change is needed. Do not run the parent `yarn start` for this site.

## Structure and editing

- `app/`: server-rendered homepage, Jobs and Contact; metadata, robots, sitemap, legal placeholders and 404.
- `components/ui/`: reusable ButtonLink and Radix Dialog-based Sheet, using shadcn-compatible aliases/config.
- `components/shared/`: floating navigation and IntersectionObserver motion primitives.
- `components/sections/`: original recruitment sections and interactive contact choices.
- `data/jobs.ts`: typed records with id, title, location, type, sector, summary, active, applyUrl. Current examples are inactive and are labelled role categories, never active vacancies. Confirm every listing and its destination before setting active=true. No JobPosting schema is currently emitted.
- `lib/site.ts`: contact details, navigation and canonical URL.
- `styles/globals.css`: palette, spacing, typography, radius, container and motion tokens plus responsive layout.
- `public/og-image.svg` and `.png`: original social graphic. No stock photography or remote font requests. Original text monogram is proposed branding, requiring approval.

## Motion

One pauseable sector marquee; hero entrance and ambient drift; one-shot scroll reveals; sequential workflow nodes/connectors; one sticky desktop heading; desktop pointer tilt and progressive CSS scroll depth. No scroll hijack or animation framework. `prefers-reduced-motion` disables movement and displays final states. Content remains visible without JavaScript; the mobile Sheet requires JavaScript, while footer links remain available.

## Contact and privacy

The contact page provides direct telephone and a hospitality CV email link. It has no submit form, upload, analytics, cookies integration or credentials. It does not pretend to send a message. A future contact form requires server-side validation, bounded payloads, abuse controls, private mail credentials and approved privacy copy. No backend integration is included.

## SEO and environment

Title/description, route canonicals, Open Graph/Twitter PNG, EmploymentAgency structured data, robots and sitemap are implemented. Optional `NEXT_PUBLIC_SITE_URL` sets the canonical public origin (default: https://www.adolphusgroup.com). This is public configuration, never a secret. Use the eventual real canonical domain for release. Preview hosts should be protected/noindex at the hosting layer. Legal placeholders are noindex and excluded from the sitemap.

## Deployment

Not deployed. First approve brand/copy, legal pages, contact details and current sector scope. For Vercel, create a **separate project**, root directory `packages/rab-website`, framework Next.js, install `npm ci --workspaces=false`, build `npm run build`; do not connect the SaaS deployment. Alternatively run the production Node server behind your existing HTTPS reverse proxy using `npm start` (3100). Contact uses server-rendered query state, so this is not configured as a pure static export. Set the canonical origin and verify metadata/links after deployment. No production infrastructure is modified by this project.

Read `docs/HANDOFF.md`, `docs/content-audit.md`, `docs/motion-reference.md` and `docs/REBUILD-REPORT.md` before future changes. The reference video and hero source were not supplied; exact video comparison remains pending.


## Hospitality story section

The second visual section remains `components/sections/recruitment-stack.tsx`. Its four cards live in `recruitment-cards.tsx`, styling in `recruitment-stack.module.css`, and motion lifecycle in `lib/use-recruitment-motion.ts`. The photo is the user-supplied `image/hero.jpg`; replace only with an approved local asset and update its meaningful alt text. Uses Next/Image with responsive sizing and lazy loading.

With the production preview on port 3100, run `node tests/recruitment-story.mjs` for eight-size/accessibility checks and `node tests/recruitment-motion.mjs` for motion assertions/recording. Evidence is under `qa/recruitment-story/`; implementation details and limitations are in `docs/RECRUITMENT-STORY-REPORT.md`. Sector links reach the existing Contact route; they currently do not prefill a sector. No extra environment variables or packages are needed.
