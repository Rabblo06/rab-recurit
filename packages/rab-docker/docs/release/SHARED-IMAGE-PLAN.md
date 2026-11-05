# Shared API/Worker image: plan (O1 implements the image; proofs below partly open)

**Status (2026-11-05): O1 ("EXACTLY LIKE TWENTY", owner-approved) implements the one image.** `rab/Dockerfile` (stage
`rab`) now carries the API and the Worker; the Worker runs it with `node packages/rab-worker/dist/main.js`.
`Dockerfile.worker-bundle`, `start-worker.sh` and the root launcher `start-worker-bundle.cjs` are deleted. The image gate
has ONE role (`image`, the union of the former `api` and `worker` checks: forbidden lists, PDF render, jobs dirs,
module-path identities for uid 1000 with and without `HOME=/nonexistent`). Publishing pushes the one gated index under
ONE tag, the full commit (O2), and every compose file takes ONE digest, `CREWFLOW_IMAGE_DIGEST`. Proofs 1-2
below (SBOM diff justification, "the API never loads PDF-only packages") are NOT yet automated by O1: the merged
runtime-deps check forbids the same build/test tooling across every dist directory, but the import-graph / `require.cache`
check is still open. The text below is the original plan, kept for those proofs.

**Original status (2026-11-04): plan only.** The owner-login deployment kept the **two** hardened images:
- the API image (`rab/Dockerfile`);
- the Worker image (`rab/Dockerfile.worker-bundle`, built FROM the API image).

This plan says what a later PR must **prove** before one image serves both roles. It is PR #10 in the owner's order, and
starts only after #61/#62 (Chromium removal, native PDF) have merged.

## Why it is deferred

- **M0-F (VERIFIED) on today's main.** The Worker image is FROM the API image. "Shared" would mean running the API from the Worker image. That saves **0 bytes** of registry storage, and before #61 it would put Chromium inside the API.
- **REPORT-G sizes after #63 (amd64):**

  | Image | Compressed | Uncompressed |
  |---|---|---|
  | API | 115.8 MB | 421.5 MB |
  | Worker | 123.7 MB | 452.4 MB |

  A shared image adds about **+8 MB compressed / +31 MB uncompressed** of Worker-only packages to the API.
- **The gain is operational, not size:** one digest to promote, and one image the release gates scan.
- **The cost is a larger API attack surface.** Worker-only packages are present in the API process's filesystem, even if never loaded.

## What the PR must prove (each item a CI check or a recorded measurement, before review)

1. **Minimal dependencies.**
   - Diff the SBOMs (SPDX) of the API image and the candidate. List every added package and justify each as Worker-only (the native PDF renderer and its dependencies).
   - Nothing else may be added.
   - `runtime-deps.cjs check` still forbids the build and test tooling (`typescript`, `nx`, `jest`, `ts-node`, `esbuild`, `@swc/*` except the owner-approved named compilers, `vite`, `webpack`, `@playwright/test`, …) across every dist directory.
2. **The API does not load browser or PDF-only packages.** Two checks, both required:
   - **Static:** an import-graph check on `packages/rab-server/dist` from the API entry (`main.js`, `api-prestart.sh`'s node calls). The PDF/renderer modules must be unreachable.
   - **Runtime:** boot the API in CI with a test-only preload that records `require.cache` and ESM loads, then assert that no path under the Worker-only packages was loaded. The preload is never in the image.
   - Today the separation is structural (the packages are absent from the API image). After the change it rests on these checks, so they are gates, not reports.
3. **The Worker renders PDFs from the shared image.** Run `scripts/image-security/pdf-render-smoke.cjs` for every report type, on **amd64 and arm64**, as uid 1000, with:
   - a read-only root;
   - `cap_drop ALL`, no-new-privileges, `--network none`;
   - the Worker's tmpfs layout.

   Equal output to the two-image baseline (`ci-pdf-equality.yaml`).
4. **Startup roles.**
   - **One image, two commands, no role switch:**
     - API: `./api-prestart.sh`;
     - Worker: `node packages/rab-worker/dist/main.js`.

     No environment variable may turn one into the other.
   - **The image's default `USER` becomes `1000:1000`.** This also removes the "Worker runs as root when a platform drops `user:`" failure mode (M0 D11). The default `CMD` is the API.
   - **The Worker must refuse to start from the API command and vice versa**, if any role-specific guard exists. Prove each role's boot gates still run.
   - **The H6 runtime matrix (M01–M21) passes for both roles from the one digest.** That includes the Worker's own isolation self-check, ported out of the retired launcher.
5. **Size and memory acceptance.** The owner sets the thresholds; proposed:
   - the candidate's compressed size is ≤ the API image + 10 MB;
   - API idle and p95 RSS under the standard load are within +5 % of the two-image API;
   - Worker RSS is unchanged within ±5 %;
   - API cold start is within +10 %.

   Measure on amd64 and arm64.
6. **Gates intact.** None of these may be loosened to fit the shared image:
   - `image_gate.py` / `policy.json` (any change only stricter);
   - Trivy and Grype with 0 High/Critical and `vulnerability-decisions.json` still empty, or each entry owner-approved;
   - SBOM must-not-include (no browser, no Chromium libraries);
   - `check-no-browser`;
   - SLSA provenance and the worker-base chain;
   - `release_guard.py` exact-SHA;
   - the immutable-tag publish.

   The release workflow publishes **one** digest and the compose files reference it twice.
7. **Compose and gate updates (same PR).**
   - `docker-compose.image.yml` uses one digest variable for rab-api, rab-worker and rab-migrate.
   - `compose-owner-login.cjs` asserts that all three resolve to the same digest, and keeps every other check.
   - `verify-image-compose.cjs` follows.
8. **Rollback.** The previous two-image digests remain deployable unchanged, because compose can take two digest variables again. Document the switch back in `OWNER-LOGIN-DEPLOYMENT.md` section 3.6.

## Out of scope for that PR

- Any change to the database login model.
- OpenShip support. Even with `USER 1000`, OpenShip still drops `read_only`, `cap_drop`, `security_opt`, `pids_limit` and the tmpfs mounts, so D11 stands.
