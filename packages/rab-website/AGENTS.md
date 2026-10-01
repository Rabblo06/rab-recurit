# Website working agreement

Read docs/HANDOFF.md, docs/content-audit.md and docs/motion-reference.md before changes.
This is an independent Next.js project at C:/Rab-recruit/packages/rab-website.
Never import SaaS runtime code or credentials. Use npm commands in this directory;
do not modify the parent Yarn workspace or lockfile. Keep jobs inactive until verified.
Respect reduced motion, accessible dialog navigation and progressive enhancement.
Update this site's handoff and the repository's canonical docs/HANDOFF.md after substantial work.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
