# Running and maintaining the Crewflow docs

The documentation site is a [Mintlify](https://mintlify.com/docs) project in `packages/rab-docs/`. It is deliberately **not** a Yarn workspace or Nx project (no `package.json`), so it adds nothing to the monorepo's lockfile, CI or Docker image.

## Requirements

- Node.js 20.17 or later (the repo's Node 24 works; Mintlify does not support Node 25+).
- The Mintlify CLI, package **`mint`** (not the legacy `mintlify` package). Tested with `mint@4.2.1018`.

```bash
npm i -g mint@4.2.1018     # or run every command below with: npx mint@4.2.1018 <command>
```

On Windows, the CLI fails if your user folder path contains a space (Mintlify issue #1793); use WSL in that case.

## Preview locally

```bash
cd packages/rab-docs
mint dev                   # http://localhost:3000 — use --port 3333 if the API already uses 3000
```

`mint dev` hot-reloads MDX, `docs.json`, `style.css` and media.

## Validate

Run all of these before opening a pull request:

```bash
cd packages/rab-docs
mint validate                                  # strict build: fails on any warning
mint broken-links --check-anchors --check-snippets
mint a11y                                      # contrast and missing alt text
FFMPEG=/path/to/ffmpeg node tools/check-docs.cjs   # media, videos, navigation, titles, public-content safety
```

`tools/check-docs.cjs` exits non-zero if any referenced image or video is missing, a video is not H.264 MP4 or exceeds 20 MB, a page is missing from navigation, two pages share a title, an `<img>` lacks alt text, or a public page contains a secret-looking value or an internal path.

## Project layout

| Path | Contents |
| --- | --- |
| `docs.json` | Site configuration and navigation (tabs → groups → pages). |
| `style.css` | Small visual refinements; Mintlify loads every root `.css` file. |
| `snippets/` | Reusable MDX: `media.mdx` (`VideoTutorial`, `PhoneShots`, `CapturePending`), `demo-data-note.mdx`. |
| `index.mdx`, `getting-started/`, `account/`, `workspaces/`, `staff/`, `venues/`, `shifts/`, `calendar/`, `attendance/`, `payroll/`, `notifications/`, `support/` | User guide. |
| `mobile/` | Staff and venue manager app guides. |
| `security/` | Security and privacy. |
| `developers/` | Developer documentation; `developers/api-reference/endpoints.mdx` is generated. |
| `images/`, `videos/` | Published media. `images/mobile/raw/` and `videos/raw-mobile/` are capture inputs and excluded from the site. |
| `tools/` | Capture, generation and QA scripts (excluded from the site). |
| `internal/` | These maintainer notes (excluded from the site). |
| `.mintignore` | Excludes `internal/`, `tools/` and raw capture folders from the build. |

## Regenerating content

| What | Command (from the repo root) |
| --- | --- |
| API endpoint reference | `node packages/rab-docs/tools/generate-api-reference.cjs` |
| Brand assets | `node packages/rab-docs/tools/build-brand.cjs` |
| Web screenshots, narrated tutorials, captions, transcripts | See `internal/DOCS_UPDATE_2026-10-20.md` → *Capture and narration pipeline* (`tools/web/*`, `tools/narration/*`, `tools/compose-videos.cjs`) |
| Web screenshots | Start the web console (`yarn start` or the Vite dev server on 5173), then `node packages/rab-docs/tools/web/capture-screens.cjs` |
| Web tutorial recordings | `node packages/rab-docs/tools/web/record-tutorials.cjs` |
| Mobile screenshots and recordings | See `tools/MOBILE_CAPTURE.md` |
| Finished videos and posters | `FFMPEG=… REC_DIR=… node packages/rab-docs/tools/compose-videos.cjs [slug…]` |
| Image optimisation | `FFMPEG=… node packages/rab-docs/tools/process-images.cjs` |

All captures use the real Crewflow interfaces with **synthetic** data supplied by fixture layers in `tools/`. They never touch a real API or database.

## Configuration you may need to change

| Setting | Where | Current value |
| --- | --- | --- |
| Web console URL (navbar button, footer, page links) | `docs.json` → `navbar.primary.href`, `footer.links`, `variables.appUrl`; and the `[{{appUrl}}](…)` links in `account/signing-in.mdx`, `account/google-and-microsoft-sign-in.mdx`, `getting-started/quickstart-manager.mdx`, `getting-started/web-app-overview.mdx` | `https://app.rabworkspaceteams.co.uk` |
| Company name | `docs.json` → `variables.company` | Adolphus Recruitment Solutions |
| Brand colours | `docs.json` → `colors` (match `--color-accent` in `packages/rab-front/src/index.css`) | `#79543A` / `#D97A52` |
| GitHub link | `docs.json` → `footer.socials.github` | Public repository |

## Deploying

1. Create a Mintlify project and install the **Mintlify GitHub App** on `Rabblo06/rab-recurit` only ("Only select repositories").
2. In the Mintlify dashboard → **Git Settings**, enable **"docs.json is in a subdirectory"** and enter `/packages/rab-docs` (no trailing slash). Choose the deployment branch (`main`).
3. Save; Mintlify deploys on every push to that branch and builds previews for pull requests.
4. In **Settings → General → Feedback**, enable thumbs ratings (and edit suggestions / issues if wanted). Feedback is a dashboard setting on Pro/Enterprise plans, not a `docs.json` key.

### Custom domain (for example `docs.<your-domain>`)

1. Run `mint add-domain docs.<your-domain>` or add it in the dashboard (**Custom domain setup**).
2. Add the DNS records the dashboard shows, **TXT records first**:
   - `TXT _acme-challenge.docs.<your-domain>` → value from the dashboard
   - `TXT _cf-custom-hostname.docs.<your-domain>` → value from the dashboard
   - `CNAME docs.<your-domain>` → `cname.mintlify.builders`
3. If the domain has CAA records, allow Let's Encrypt.
4. Add `"canonical": "https://docs.<your-domain>"` under `seo.metatags` in `docs.json`.

Do not deploy or connect the GitHub App without the repository owner's approval.

## Large files

Mintlify serves files up to **20 MB** each. Keep tutorials short (under ~90 s) and encode with `tools/compose-videos.cjs`; current videos are a few MB each. If videos grow, host them on a video platform and embed with an `<iframe>` instead.
