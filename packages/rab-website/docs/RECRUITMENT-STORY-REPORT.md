# Adolphus recruitment story section ? 25 September 2026

## Summary

Redesigned the existing RecruitmentStack section in packages/rab-website. Preserved the homepage structure, hero, header, routes, global tokens and existing application. Four original editorial cards use the approved wording and the actual user-supplied hospitality photo. No new packages or SaaS/production changes.

## Files changed

Application:
- components/sections/recruitment-stack.tsx ? existing section orchestration, editorial copy, statement and semantic sector navigation.
- components/sections/recruitment-cards.tsx ? new EmployerCard, HospitalityCard, CandidateCard and SectorSpotlight.
- components/sections/recruitment-stack.module.css ? isolated layout, responsive styles and motion states.
- lib/use-recruitment-motion.ts ? one-shot observers, bounded pointer/depth updates and cleanup.

Verification:
- tests/recruitment-story.mjs ? eight viewports, image, links, header layering, touch, accessibility, reduced motion and no-JS.
- tests/recruitment-motion.mjs ? desktop pointer/reset, scroll/exit bounds, video and frame extraction.

Documentation:
- README.md
- docs/HANDOFF.md
- docs/content-audit.md
- docs/motion-reference.md
- docs/RECRUITMENT-STORY-REPORT.md (this report)
- ../../docs/HANDOFF.md (repository-root session record)

Generated evidence: qa/recruitment-story/results.json, motion-results.json, eight *-viewport.png and *-section.png pairs, reduce.png, no-js.png, responsive-contact-sheet.jpg, motion-contact-sheet.jpg, motion.webm, inspect-motion.html, frames/00.png through 19.png and the Playwright recording/ source video. Existing npm test also refreshed qa/results.json and its standard whole-site screenshot artifacts. Existing unrelated dirty work was preserved.

## Image

Exact source: C:/Rab-recruit/packages/rab-website/image/hero.jpg (930?620). Static Next/Image import, responsive sizes, lazy loading, object-fit cover, stable portrait ratio. Alt text describes guests dining beneath crystal chandeliers. Source image itself was not modified.

## Motion and responsive behavior

Editorial copy precedes a left/right/image/spotlight assembly with 110ms stagger and restrained easing. Desktop scroll depth uses -20/-36/-14/+12px maximum travel; mouse-only pointer depth is bounded to 4/7/4/3px and smoothed through transform transitions. Hover lift and a 1.01 photo zoom remain subtle. Exit retains the composition at a minimum .985 scale/.94 opacity. No scroll trapping, animation package, permanent animation loop or React scroll rerenders.

Desktop retains asymmetric overlap. Laptop reduces dimensions/angles. Tablet uses 2-degree outer rotations with no scroll/pointer depth. Below 768px the image, employer, candidate and spotlight stack in that order, followed by statement and wrapping sector links. Reduced motion renders immediately and disables depth; no-JS content stays visible.

## Actual verification results

- npm run lint: PASS.
- npm run typecheck: PASS.
- npm run build: PASS, production routes generated.
- npm test: PASS; four viewport whole-site regression suite, routes, candidate contact, mobile menu focus trap/restore, reduced motion, no-JS, axe.
- node tests/recruitment-story.mjs: PASS at 1920?1080, 1440?900, 1280?800, 1024?768, 768?1024, 430?932, 390?844 and 375?812. No document overflow, image distortion, card-order failures, console warnings/errors or tested axe violations.
- node tests/recruitment-motion.mjs: PASS. Desktop pointer response/reset and bounded exit verified. 9.08-second local motion recording, 20 sampled frames inspected. Observed layout-shift sum: 0.
- Visual polish corrected the tablet ambient-glow overflow and ensured the front card overlaps the central portrait. Reviewed all eight sizes and motion frames. Section-only screenshots hide the fixed header/skip link during capture; viewport screenshots retain them and layering is asserted.

Automated accessibility checks do not prove complete accessibility conformance. Previous Lighthouse scores in REBUILD-REPORT.md predate this change and were not rerun. No field INP or exact reference-video timing parity is claimed.

## Remaining and preview

Preview: http://localhost:3100/#connections (local production server only). No deployment performed. Sector links use the existing Contact route with a sector query; the contact UI does not currently prefill that sector. Hospitality is a featured navigation item, not an interactive tab. The supplied PDF provides still-image composition evidence; an actual reference video is still absent. Existing legal/contact/branding release approvals documented in HANDOFF.md remain applicable. No known blocking implementation failure remains in this scoped section.
