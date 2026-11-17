# tools/untangle: codebase analysis scripts

These are the read-only scripts behind the whole-repo clean-up analysis in `docs/plans/untangle/` (cross-cutting.md §3).
Rerun them to see how the structure has moved since that analysis, before and after an untangle PR.

They only run `git ls-files` and `git log` and read tracked files. They never change the repository, install nothing
and use no network. Each one writes its report to `--out`, which defaults to `<os tmpdir>/untangle`, never the repo.
Node built-ins only. The CI gate is `tools/check-import-boundaries.cjs` (PR #191); these scripts are analysis, not a gate.

| Script | Rerun (from the repo root) | Output |
|---|---|---|
| `depgraph.mjs` | `node tools/untangle/depgraph.mjs . --out <dir> [--since "6 months ago"]` | `report.txt` and `graph.json`: package and folder import graphs (production and test), folder and file cycles (Tarjan SCC), mutual folder imports, `engine/ -> modules/`, server -> worker and worker -> server folders, rab-front and rab-mobile feature -> feature, mobile core -> features, front `shared/` files used by fewer than 3 features, stable -> volatile folder edges, Martin instability, folder churn |
| `cochange.mjs` | `node tools/untangle/cochange.mjs . --out <dir> [--max-files 40] [--min 5]` | `cochange-report.txt`: file pairs that change together across packages (production / code only / with tests), file pairs across folders, folder pairs within and across packages |
| `api-surface.mjs` | `node tools/untangle/api-surface.mjs . --out <dir>` | `api-surface.txt`: server routes (`@Controller` + `@Get`/`@Post`/...) matched against path literals in rab-front, rab-mobile, rab-iphone and e2e; routes used by two or more clients; client paths with no matching route |

How they parse:
- **TS/TSX/JS:** a regex over `import … from`, `export … from`, `require()`, `import()` and `jest.mock()`. `@rab/*`
  maps to each package's `src`, and NodeNext `.js` specifiers map to `.ts`.
- **Dart:** `import` / `export` / `part`, with `package:rab_staff/` mapped to `lib/`.
- **Swift (best effort, one module):** an edge means a file mentions a type declared in another file. This over-reports
  a little for common names.
- **"Production"** excludes `*.spec.*`, `*.test.*`, `__tests__/`, `test/`, `*Tests/`, `rab-e2e-testing/`, fixtures and
  jest setup.
- **Co-change** counts once per non-merge commit. Commits touching more than `--max-files` files are skipped, along with
  lockfiles, images and `HANDOFF.md`. Confidence is `co / min(nA, nB)`.

Their counts can differ from `check-import-boundaries.cjs`. The gate reads imports with the TypeScript pre-processor,
scans production files only and counts per importing file. `depgraph.mjs` uses a regex and also lists test edges.
