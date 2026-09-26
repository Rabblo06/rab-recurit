# ADOLPHUS GROUP WEBSITE REBUILD REPORT

Date: 25 September 2026. Local website implementation and QA; not a public deployment.

| Deliverable | Result / evidence |
| --- | --- |
| A. Existing website audit | [content-audit.md](content-audit.md): keep/rewrite/remove/approval decisions, company page sources and freshness limitations. |
| B. Reference motion analysis | [motion-reference.md](motion-reference.md): screenshot/brief analysis completed. Video and hero source were not attached; exact frame-by-frame reference comparison remains unavailable. |
| C. Project created | `C:/Rab-recruit/packages/rab-website`, following the user's moved directory. No duplicate root project. |
| D. Stack | Next.js 16.3.6, React 19.3.0, TypeScript, Tailwind 4.3.3, Radix Dialog, Lucide. Independent npm lockfile; SaaS Yarn/Nx unchanged. |
| E. Components | ButtonLink, accessible Sheet, FloatingNav/Wordmark, MotionReveal/SectionHeading, Hero, SectorMarquee, RecruitmentStack, RecruitmentFlow, Process, ClientCandidateSplit, Sectors, Jobs, Trust, ContactCTA, Footer and contact options. |
| F. Sections | Full homepage plus Jobs, Contact, explicit legal placeholders and 404. Employer/candidate paths, editorial introduction and company positioning included. |
| G. Interactions | Hero entrance, ambient drift, pauseable marquee, subtle pointer/scroll card depth, sequential workflow connectors, sticky desktop heading, card/button hover feedback, reduced-motion final states. |
| H. Desktop | [1440 hero](../qa/desktop-hero.png), [1920 hero](../qa/wide-hero.png), [all desktop sections](../qa/desktop-contact-sheet.png), full-page PNGs in qa/. |
| I. Tablet | [1024 screenshot](../qa/tablet-full.png). |
| J. Mobile | [390 hero](../qa/mobile-hero.png), [all mobile sections](../qa/mobile-contact-sheet.png), [menu](../qa/mobile-menu.png), [contact](../qa/mobile-contact.png), [reduced motion](../qa/mobile-reduced-motion.png). |
| K. Accessibility | Real Chrome + axe: no violations in tested homepage/contact viewports. Keyboard focus trap, Escape/restore, labels, routes, no-JS content and reduced motion verified. Lighthouse Accessibility 100. Not a full manual assistive-technology certification. |
| L. Performance | Lighthouse mobile simulation: Performance 99, Accessibility 100, Best Practices 100, SEO 100. LCP 2.2s, CLS 0, TBT 20ms, FCP 0.8s. [Report](../qa/lighthouse-mobile.html), [machine results](../qa/performance-summary.json). These are local lab results, not field INP or production guarantees. |
| M. SEO | Route titles/descriptions, canonical URLs, OG/Twitter PNG, EmploymentAgency JSON-LD, robots and sitemap. No fabricated JobPosting schema. Legal drafts noindex. |
| N. Approvals | Proposed wordmark/palette/copy, contact freshness, sector availability, legal text and any future active vacancy. No invented testimonials or claims. Development-only testimonial placeholder. |
| O. Files | New website files confined to packages/rab-website; root README corrected for moved assets/project tree; canonical root handoff updated. No backend/mobile/infrastructure changes. User's asset move preserved. |
| P. Deployment | [README](../README.md): separate hosting project with this directory as root, npm ci --workspaces=false, npm run build, npm start on 3100 or Vercel Next.js. Public launch awaits content/legal approval. |
| Q. Handoff | [HANDOFF.md](HANDOFF.md), site AGENTS.md and root docs/HANDOFF.md. |

## Motion QA

A 10.84-second continuous desktop scroll was recorded locally: [full-scroll.webm](../qa/full-scroll.webm). Sixteen sampled video frames were extracted and reviewed: [frame sheet](../qa/scroll-frames.png). No visible layout jumps, layer clipping or sticky glitches in sampled frames. This is sampled motion inspection, not exhaustive frame-by-frame certification. Desktop and mobile section screenshots were also inspected. Exact comparison to the missing reference video remains pending.

## Fixes found by QA

- Fixed wordmark contrast when the fixed header crosses a dark section.
- Darkened marquee text and the decorative introduction mark.
- Added the recruitment illustration's section heading to avoid skipping from h1 to h3.
- Corrected the candidate contact path to select the candidate option on arrival.
- Used a PNG social preview for broad crawler compatibility.

## Verification

Production build and TypeScript passed; lint passed; dependency audit reports zero vulnerabilities. Automated browser checks cover four requested viewports, all section overflow checks, jobs-to-contact navigation, mobile Sheet focus management, reduced motion and visible no-JS content. The production server is available locally at http://localhost:3100 while the development session remains active. Browser evidence is generated against the production build.

No form data is collected, no emails are sent by the application, and no SaaS credentials or APIs are used. Contact actions are telephone/email links. Legal approval and current job confirmation remain release tasks, not fabricated finished content.
