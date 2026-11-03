# Image security release policy (Docker hardening H5)

This policy covers the Crewflow API image (`packages/rab-docker/rab/Dockerfile`, final stage `rab`) and the Worker bundle
image (`packages/rab-docker/rab/Dockerfile.worker-bundle`, built FROM the API image). It says which checks block a
release, how the version floors are raised, and how a finding that cannot be fixed gets an explicit owner decision.

| File | Purpose |
|---|---|
| `.github/workflows/image-security-gate.yaml` | The gate: builds both images per platform and checks them |
| `.github/workflows/ci-security.yaml` (`image-gate`, `ci-security-gate`) | Runs the gate on every PR and every push to `main`, in PR mode |
| `.github/workflows/publish-image.yaml` | Runs the gate in release mode on both platforms, then (after approval of the `release` environment) pushes the exact gated API and Worker indexes to `docker.io/adhin007/adolphus` |
| `packages/rab-docker/scripts/image-security/publish-gated.sh` | The only push path: one gated index, one immutable tag, existing tags refused, served digests verified |
| `packages/rab-docker/rab/security-floors.env` | Minimum Node, Chromium and libexpat versions, the Alpine branch, npm floors |
| `packages/rab-docker/rab/security-floors.sh`, `module-paths-gate.cjs` | H1 build-time gates, re-run by the gate against the finished image |
| `packages/rab-docker/scripts/image-security/policy.json` | Expected users, entrypoints, writable dirs, code paths, package lists, scanner pins |
| `packages/rab-docker/scripts/image-security/vulnerability-decisions.json` | Owner risk decisions (empty until the owner decides) |
| `packages/rab-docker/scripts/image-security/scanner-blind-advisories.json` | Known High advisories that the scanners miss |
| `packages/rab-docker/scripts/image-security/image_gate.py` | The checks; `tests/` holds their self-tests |

## 1. When the gate runs

| Trigger | Mode | Platforms | Pushes an image? |
|---|---|---|---|
| Pull request, push to `main` (`ci-security.yaml`) | `pr` | linux/amd64; linux/arm64 too when Docker inputs change (`changed-files.yaml` `docker` filter) | **No.** The gate workflow only has `contents: read` (+ `security-events: write` for SARIF) and never logs in to a registry |
| `workflow_dispatch` of `image-security-gate.yaml` | `release` | both | No. It builds (or verifies a candidate) and exports the gated layouts as a candidate |
| `workflow_dispatch` of `publish-image.yaml`, `mode: candidate-verify` (default) | `release` | both | **No.** It runs the full gate, including the native amd64 + arm64 PDF render, against a fresh build or an earlier candidate given by run id and index digests |
| GitHub release published, or `workflow_dispatch` of `publish-image.yaml` with `mode: publish` | `release` | both | Only after the gate passes **and** a required reviewer approves the `release` environment, and only the gated digests |

A merge to `main` never publishes or deploys anything through these workflows. Each platform is built on a native
runner (`ubuntu-24.04`, `ubuntu-24.04-arm`) with `--pull --no-cache`, so no cached apk layer can skip a newer package.
The floors are also re-checked inside the finished image, so a cached layer cannot bypass them.

## 2. Modes and what blocks

Each check reports PASS, HOLD or FAIL. **FAIL blocks in every mode.** **HOLD** is a release-only block. On a pull request
it appears as a warning and in the job summary as *NEEDS OWNER APPROVAL (blocks a release)*. In release mode it is a
failure. Checks that did not run (because the build failed, a step was skipped, or a platform is missing) count as
FAILED in the summary, and the aggregate jobs (`image security gate`, `ci-security gate`) fail unless every required job
succeeded. The default mode of `image_gate.py` is `release`, so forgetting the flag can only make a check stricter.

| Check (`image_gate.py` command) | FAIL (every mode) | HOLD (blocks a release) |
|---|---|---|
| `static` | Unpinned `FROM` / `COPY --from` / remote `ADD`; floors file malformed; decision register invalid or expired; scanner image not pinned by digest | Unpinned `# syntax=` frontend line |
| `config` | Wrong platform, runtime user, entrypoint, cmd, exposed ports or healthcheck; `org.opencontainers.image.revision` ≠ the source commit; a secret-like env name or a URL with credentials in the image config | – |
| `container` | `security-floors.sh` fails inside the image (Node, Chromium, libexpat below the floor; Alpine branch or repositories wrong; Chromium present in the API); Chromium binary version below the floor; `module-paths-gate.cjs` finds a writable module path or a plantable `$HOME/.node_modules` for any runtime identity | – |
| `fs` (exported filesystem) | setuid/setgid file; file capability; world-writable file or a non-sticky world-writable directory; code under `/app`, `/opt/crewflow-bundle`, `/usr/local`, `/usr/lib/chromium` not `0:0` or group/other-writable; HOME writable; extra uid 0 account; unapproved apk repository, drop-in, apk config or tag pin; test files, `.env*` files or `.git` in application code; esbuild/vite; an npm package below an `NPM_FLOOR` | Development-only packages (the H3 list in `policy.json`) |
| `worker-base` | The Worker's lower layers are not exactly the gated API image's layers | – |
| `scan` | A scanner failed; the scanner version is not the pinned one; DB older than 72 h; the scanned image ID or layer chain is not the gated image | – |
| `vulns` | **Fixable** High/Critical (either scanner knows a fixed version) without a valid owner decision | **Unfixed** High/Critical without a valid owner decision; a watch-list package whose version changed (re-verify) |
| `pdf` (Worker) | No PDF: the launcher's jobs-child plan is not `HOME=/nonexistent` + its own TMPDIR/XDG dirs; the render through the production renderer fails; the output lacks a `%PDF-` header, `%%EOF`, a page, the known text markers (including the synthetic markup, which must come out as literal text) or an embedded image; the image ran on a host of another architecture (emulated) | – |
| `secrets` | Any Trivy secret finding in any layer (including files deleted in later layers) or in the image config | – |
| `attest` | Build output is not the gated image; no SBOM; SBOM too small or missing key packages; no or more than one provenance; provenance records a build argument not in the allowlist, a build secret, SSH, a credential-like string, or a source revision ≠ the commit | – |
| `manifest` | Platforms ≠ the expected set; config OS/architecture ≠ descriptor; an image without its attestation manifest; revision label mismatch; Worker not layered on the API for every platform | – |

Medium and Low findings never block. They are counted and listed in the evidence artifacts and the job summary.

**Fixable vs unfixed.** A finding is *fixable* if either scanner reports a fixed version. A fixable High or Critical
finding must be fixed by rebuilding or upgrading. An *unfixed* High or Critical finding cannot be fixed by rebuilding,
so it needs an explicit owner decision before a release (section 5). It is never silenced.

## 3. Floors (`security-floors.env`)

- `MIN_NODE_VERSION`, `MIN_CHROMIUM_VERSION`, `MIN_LIBEXPAT_VERSION` and `ALPINE_BRANCH` are read by
  `security-floors.sh` at build time and again by the gate inside the finished image. A build argument with the same
  name can only **raise** a floor. All comparisons are real version comparisons (`apk version -t` for Alpine packages;
  numeric comparison for Node and for the Chromium binary's own `--version`), never string comparisons.
- `NPM_FLOOR=<package>@<major.minor.patch>` (repeatable) sets a minimum for **every installed copy** of an npm package in
  the image, using semantic-version precedence. Use it for patched-dependency requirements (for example
  `NPM_FLOOR=prismjs@1.30.0` once H4a merges).
- **Raising a floor** after a security release (Chrome stable, Node, Alpine):
  1. Confirm that the fixed package is in Alpine `v3.24/main|community` (`apk policy`, APKINDEX) or that the Node base
     digest has it.
  2. Raise the value in `security-floors.env` (and bump the `node:24-alpine@sha256` digest in **both** `FROM` lines for
     Node).
  3. Open a PR. The PR gate builds without cache and fails if the repositories do not serve the new version yet.
- Floors are never lowered to make a build pass. A floor that cannot be met yet means waiting for the fix or an owner
  decision, not editing the floor.
- Changing `ALPINE_BRANCH` (for example to v3.25) is a base-image migration. Change the base digest, re-baseline the
  scanners, and re-verify the watch list at the same time.

## 4. Scanners

Trivy and Grype run as container images pinned by tag **and** digest (`policy.json` `scanners`). Each run downloads a
fresh vulnerability DB, and the gate fails if a DB is older than 72 hours. Versions and DB timestamps are written to
`<role>-scanner-versions.json` in the evidence artifact.

To update a scanner:
1. Resolve the new tag's multi-arch digest with `docker buildx imagetools inspect`.
2. Update `image`, `version` and the comment in the PR, and compare the findings before and after in the PR description.

Neither scanner can see Chromium's own CVEs (Alpine's secdb stops at 144) or the tarball-installed Node runtime. The
floors are the only control for those, so they are never dropped because a scanner reports zero. Docker Scout is not
used: it needs a Docker Hub credential, which has not been approved (section 9).

## 5. Owner risk decisions (`vulnerability-decisions.json`)

The register is **not** an ignore list. It is the written record of an owner decision, and the gate validates each
entry:

```json
{
  "id": "CVE-2026-67215",
  "packages": ["cjson"],
  "images": ["worker"],
  "decision": "accepted-risk",
  "owner_decision_ref": "https://github.com/Rabblo06/rab-recurit/issues/<n> (or PR comment URL)",
  "decided_by": "<owner>",
  "decided_on": "YYYY-MM-DD",
  "expires": "YYYY-MM-DD",
  "justification": "Reachability evidence: ... (link the analysis)"
}
```

Rules, all enforced by `image_gate.py static` / `vulns`:
- An entry names exactly **one** advisory (a CVE or GHSA id, no wildcard) and an explicit list of exact package names.
- `decision` is one of:
  - `accepted-risk`: the risk is real and accepted until the expiry date;
  - `not-affected`: the code path or version is not affected, with evidence;
  - `false-positive`: the scanner matched the wrong thing.
- `expires` is at most **180 days** after `decided_on`. After it expires, the entry fails the gate and the finding counts
  as undecided again. Renewing an entry needs a new decision.
- A decision changes only the verdict on a matching High or Critical finding (it is shown as "decided" in the summary).
  It never hides the finding from the evidence. An unused decision is reported so it can be removed.
- Entries are added in a PR that links the owner's written decision. An agent or a CI job never adds one on its own
  initiative.

**Current state (2026-11-03): the register is empty.** The Worker's unfixed High/Critical findings (the seven
Chromium-dependency CVEs from the 2026-11-02 report, plus those Grype reports through NVD CPE matching) appear as HOLD on
every PR and block a release until the owner decides on each one.

## 6. Scanner-blind watch list (`scanner-blind-advisories.json`)

Some advisories are reported by neither scanner. Trivy reads Alpine's secdb, which lists fixed CVEs only. Grype matches
some of these advisories only through NVD CPE ranges. Each watch-list entry **adds** a finding when one of its packages is
installed:
- at a listed affected version, it is an unfixed High finding;
- at any other version, it is a HOLD that asks for re-verification against the Alpine security tracker.

The list never removes or downgrades a scanner finding. Re-verify it on every Alpine point release and at least monthly,
and update `verified_on`.

## 7. SBOM and provenance

- Every gate build attaches a BuildKit **SPDX SBOM** and **SLSA provenance** (`mode=max`) to the OCI image index.
  - The SBOM generator (`docker/buildkit-syft-scanner`), the BuildKit image and the Dockerfile frontend are pinned by
    digest in `build-gate-images.sh` and the workflow.
  - The gate checks that the SBOM lists the expected packages.
  - The gate checks that the provenance names the image manifest, records the source commit, and records no build
    argument outside `policy.json` `provenance.allowed_build_args`, no build secret, no SSH and no credential-like
    string.
- Trivy also writes a **CycloneDX** SBOM of the exact image (`<role>-sbom.cdx.json`).
- Each platform's evidence artifact (`image-gate-evidence-<arch>`) contains:
  - the results;
  - the raw scanner JSON;
  - the SPDX and CycloneDX SBOMs;
  - the provenance;
  - the scanner versions and DB timestamps;
  - the build metadata.
- On publish, `actions/attest-build-provenance` adds a GitHub-signed provenance attestation for the pushed index digest.
  It uses `GITHUB_TOKEN` with `id-token: write` and `attestations: write`, on the publish job only.

## 8. Publishing and tags

- **Target.** The private Docker Hub repository `docker.io/adhin007/adolphus`. GHCR is no longer published to: a
  second registry would need its own tag policy, verification and cleanup, so it does not come for free. Both images
  come from the same commit and are multi-arch indexes (linux/amd64 + linux/arm64).
- **Exactly two immutable tags per release:**
  - `api-<full commit sha>` and `worker-<full commit sha>`;
  - no `latest`, no version or per-architecture tags, nothing that moves;
  - the push refuses any existing tag, whatever digest it points at.

  **Deploy only by index digest:** `docker.io/adhin007/adolphus@sha256:...`, taken from the release manifest. The tags
  are labels, not references.
- **What is pushed.**
  1. The Worker is built FROM the API image of the same run, through an OCI-layout build context pinned by digest. The
     gate proves this from the Worker's provenance (its `crewflow-gate-api-base` dependency must resolve to the gated
     API image for that platform) and from its layer chain.
  2. The publish job pushes exactly the two gated layouts with `publish-gated.sh`, which:
     - checks every blob hash and the expected index digest;
     - logs in with the environment secret;
     - fails if the tag exists, or if the registry's answer is anything but "not found";
     - copies with `skopeo copy --all --preserve-digests` (no rebuild);
     - verifies that the tag, the index digest and every per-platform manifest are served with exactly the gated
       digests.
- **Approval.** The `publish` job runs in the GitHub environment `release`, which must have required reviewers.
  `environment-check` fails the run before anything is built if the environment is missing or unprotected. The reviewer
  approves after the gate's results are visible, including the native ARM64 PDF render of the exact candidate.
- **Candidate verify.** `publish-image.yaml` -> Run workflow -> `mode: candidate-verify`, with an optional
  `candidate-run-id` plus both index digests (from that run's `release-manifest-candidate` artifact):
  - re-runs every gate against exactly that candidate, including the native PDF render on both architectures;
  - never publishes;
  - to publish a verified candidate, dispatch again with `mode: publish` and the same three inputs;
  - dispatch on the candidate's commit, because the revision checks compare the images with the checked-out commit.
- **Release manifest.** The gate's manifest job writes `release-manifest-candidate` with:
  - the commit;
  - both index digests and references, and the per-platform manifest digests;
  - the SBOM (SPDX) and provenance (SLSA v1) attestation-manifest and blob digests;
  - the Worker's recorded base;
  - the scanner versions and DB timestamps per image and platform;
  - the native PDF render results.

  After the push, the publish job adds the published tags and the GitHub attestation URLs, and uploads it as
  `release-manifest` (retained 90 days).

## 9. Credentials

| Need | Credential | Where it is available |
|---|---|---|
| Build, gate, Trivy, Grype, DB downloads, SBOM, BuildKit provenance, candidate download | none (`GITHUB_TOKEN` `contents: read`, `actions: read`) | gate jobs |
| SARIF upload to code scanning | `GITHUB_TOKEN` `security-events: write` | gate image job |
| Push to `docker.io/adhin007/adolphus` | **secret `DOCKERHUB_PUSH_TOKEN`** + **variable `DOCKERHUB_USERNAME`** | **only** the `publish` job, through the protected environment `release` |
| GitHub build-provenance attestation | `GITHUB_TOKEN` `id-token: write` + `attestations: write` | `publish` job only |
| Read `release` environment protection | `GITHUB_TOKEN` (public repository) | `environment-check` |

**Docker Hub token: what the owner creates, by hand, once.**

- **Account type.** `adhin007` is a **personal** Docker account (Docker Hub API `type: User`). Docker's repository-scoped
  *organization access tokens* (Image Push scope on chosen repositories) exist only for organizations on a Docker Team or
  Business plan. For this account, the minimum is a **personal access token**.
- **Token.** A personal access token with permission **"Repo Read & Write"**:
  - never "Read, Write, Delete";
  - an expiry date (for example 90 days) and a description naming this repository and workflow.

  A PAT cannot be limited to one repository: Read & Write applies to every repository the account can access.
- **Recommended mitigation.** Create a dedicated Docker account used only for CI, give it access to `adhin007/adolphus`
  only, and issue the PAT from that account. Then the token can reach nothing else. Check that the owner's Docker plan
  allows collaborators on private repositories. The stricter alternative is moving the repository into a Docker
  organization (Team plan) and using an organization access token with **Image Push** on `adolphus` only.
- **Where to put it.** GitHub -> Settings -> Environments -> **`release`**:
  - add required reviewers (at least one; preferably not the person who publishes the release);
  - add the environment **secret `DOCKERHUB_PUSH_TOKEN`** (the PAT);
  - add the environment **variable `DOCKERHUB_USERNAME`** (the account that owns the PAT);
  - optionally restrict deployment branches/tags to `main` and `rab/v*`.

  Do not create them as repository-wide secrets.
- **Fail closed.**
  - If either value is absent, the publish job stops with an explicit error before any registry call.
  - If the environment is missing or has no required reviewers, `environment-check` stops the run before the gate.
- **Usage.** The token is used only by `publish-gated.sh`, via `skopeo login --password-stdin` into a temporary auth
  file that is deleted at the end. It is never echoed, and it is not exposed to the gate, PR workflows or forks.

Docker Scout is not used.

## 10. Development dependencies (H3)

`policy.json` `packages.h3_target` lists development-only packages that H3 (production-only `node_modules`) removes.
Until H3 merges, their presence is a HOLD. Once the images are free of them, move the list into `packages.block` in the
same PR, so a regression fails every PR. `packages.block` (esbuild, vite) already fails today.

## 11. Proving a gate still fails

`image_gate.py` runs locally against any image:

```bash
python3 packages/rab-docker/scripts/image-security/image_gate.py --mode release --results /tmp/r fs worker <image>
```

The H5 PR records one intentional, non-secret violation per gate, run against a throwaway local image. Repeat that
when you change a check. `tests/` covers the policy logic without Docker:

```bash
python3 -m unittest discover -s packages/rab-docker/scripts/image-security/tests
```
