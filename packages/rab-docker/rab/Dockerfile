# syntax=docker/dockerfile:1

# Security floors (H1): the minimum Node, Chromium and libexpat versions, and the only Alpine branch apk may resolve from,
# live in ONE place: packages/rab-docker/rab/security-floors.env. The stages below run security-floors.sh against it
# through a build-time bind mount (nothing is copied into an image); a version below a floor FAILS the build, there is no
# warn-only mode. A build argument of the same name can only RAISE a floor, never lower it.
#
# node:24-alpine = Node 24.22.2 on Alpine 3.24.3, pinned by its multi-arch OCI INDEX digest (linux/amd64 + linux/arm64/v8;
# verified 2026-11-02 with `docker buildx imagetools inspect node:24-alpine` and `node -v` on both platforms). The final
# stage uses the SAME digest: keep the two FROM lines in step.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
ARG MIN_NODE_VERSION
# The Node that compiles the native modules (argon2) in `deps` is held to the same floor as the runtime.
RUN --mount=type=bind,source=packages/rab-docker/rab/security-floors.sh,target=/tmp/security-floors.sh \
    --mount=type=bind,source=packages/rab-docker/rab/security-floors.env,target=/tmp/security-floors.env \
    sh /tmp/security-floors.sh /tmp/security-floors.env node alpine
# python3/make/g++: fallback native build toolchain for deps that ship no
# prebuilt musl binary (e.g. bcrypt, landing in M1).
RUN apk add --no-cache python3 make g++ \
  && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages/rab-server/package.json packages/rab-server/package.json
COPY packages/rab-worker/package.json packages/rab-worker/package.json
COPY packages/rab-shared/package.json packages/rab-shared/package.json
COPY packages/rab-ui/package.json packages/rab-ui/package.json
COPY packages/rab-front/package.json packages/rab-front/package.json
COPY packages/rab-emails/package.json packages/rab-emails/package.json
COPY packages/rab-e2e-testing/package.json packages/rab-e2e-testing/package.json
COPY packages/rab-utils/package.json packages/rab-utils/package.json
RUN yarn install --immutable

FROM deps AS build
COPY . .
# rab-worker depends on rab-server/rab-shared via `workspace:*` — Nx's own
# dependency graph builds those first automatically, no explicit ordering
# needed here (verified: rab-worker's package.json declares the dependency,
# Nx infers the build-order edge from it).
RUN npx nx run-many -t build -p rab-server,rab-worker,rab-shared,rab-ui
# BUILD-01 regression guard: a silently-incomplete `rab-worker` build (e.g.
# the project dropping out of the Nx/Yarn workspace graph, as happened when
# it was untracked) must fail the image build loudly, here, rather than
# produce an image that looks fine and crashes at container startup with
# "Cannot find module '/app/packages/rab-worker/dist/main.js'" — exactly the
# failure a clean checkout of a stale commit reproduced.
RUN test -f packages/rab-worker/dist/main.js || (echo "FATAL: packages/rab-worker/dist/main.js was not produced by the build above — rab-worker build is incomplete or missing from the workspace." && exit 1)
RUN test -f packages/rab-server/dist/main.js || (echo "FATAL: packages/rab-server/dist/main.js was not produced by the build above." && exit 1)
# H1: compiled tests never reach a runtime image. tsc already skips *.spec.ts/*.test.ts, but rab-worker compiles its
# src/__tests__/** helpers (fixtures, a fake SMTP sink, test identities) into dist. Delete every __tests__/__mocks__/
# __fixtures__ directory and spec/test/jest/test-helper file from the dist folders the runtime stage copies (the source
# tree is untouched), prove nothing left there imports a deleted path, and clear any group/other write bit.
RUN set -eu; \
    dists="packages/rab-server/dist packages/rab-worker/dist packages/rab-shared/dist-cjs packages/rab-ui/dist-cjs packages/rab-emails/dist"; \
    for d in $dists; do test -d "$d"; done; \
    find $dists -type d \( -name __tests__ -o -name __mocks__ -o -name __fixtures__ \) -prune -exec rm -rf {} +; \
    find $dists -type f \( -name '*.spec.*' -o -name '*.test.*' -o -name 'jest-*' -o -name 'test-helpers.*' \) -delete; \
    left="$(find $dists \( -name __tests__ -o -name __mocks__ -o -name __fixtures__ -o -name '*.spec.*' -o -name '*.test.*' -o -name 'jest-*' -o -name 'test-helpers.*' \) -print)"; \
    if [ -n "$left" ]; then echo "FATAL: test files remain in runtime dist folders:"; echo "$left"; exit 1; fi; \
    rc=0; refs="$(grep -rlE "(require\(|from |import\()[[:space:]]*['\"][^'\"]*(/__tests__/|/__mocks__/|/__fixtures__/|\.spec(\.js)?['\"]|\.test(\.js)?['\"]|/test-helpers(\.js)?['\"]|/jest-[A-Za-z0-9-]+(\.js)?['\"])" $dists)" || rc=$?; \
    if [ "$rc" -gt 1 ]; then echo "FATAL: the import scan itself failed (grep exit $rc)"; exit 1; fi; \
    if [ -n "$refs" ]; then echo "FATAL: runtime code imports a removed test file:"; echo "$refs"; exit 1; fi; \
    find $dists ! -type l -perm /022 -exec chmod go-w {} +

# Runtime node_modules = the build stage's tree minus the build-only native toolchains (image scan 2026-10-30): the esbuild
# binaries (Vite's nested 0.25 copy embeds Go stdlib 1.23.12: 1 CRITICAL + ~25 HIGH) and Vite itself. Nothing the runtime
# starts needs them — server, Worker, shared, ui and emails dist never import esbuild, vite or tsx; only build/dev CLIs do
# (tsx, the react-email preview, Vite), and none of those runs in this image.
# H1: any group/other write bit a package tarball shipped with is cleared here (only the offending entries are touched,
# so this stage does not rewrite the whole tree); the final stage then re-verifies the whole of /app.
FROM build AS runtime-modules
RUN rm -rf node_modules/esbuild node_modules/@esbuild node_modules/vite node_modules/.bin/esbuild node_modules/.bin/vite \
      node_modules/*/node_modules/esbuild node_modules/*/node_modules/@esbuild \
      node_modules/@*/*/node_modules/esbuild node_modules/@*/*/node_modules/@esbuild \
  && test -z "$(find node_modules -type f -path '*esbuild*/bin/esbuild' -print -quit)" \
  && find node_modules ! -type l -perm /022 -exec chmod go-w {} +

# Final stage = the API image (rab-api, and the one-off rab-migrate / rab-ops). It is also the Dockerfile's last stage,
# which Docker builds by default when no `--target` is given (OpenShip and Render cannot pass one): keep it last.
# The same pinned Node image as `base`, WITHOUT base's native build toolchain (python3/make/g++/gcc): those are build-only
# (image scan 2026-10-30: python3 3.14.8 = 4 CRITICAL) and the runtime compiles nothing. Keep the digest in step with `base`.
#
# H2: NO Chromium, fonts or PDF settings here. The only code that launches a browser is the Worker's PDF renderer
# (packages/rab-worker/src/queues/rab-reports/render-pdf.util.ts); rab-server imports neither Playwright nor that file,
# and the API only serves PDFs the Worker already stored. Chromium (with its fonts, the CHROMIUM_* settings and the
# Chromium/libexpat floors) is installed by packages/rab-docker/rab/Dockerfile.worker-bundle, on top of this image, so
# the Worker reuses every layer below and the API image carries none of Chromium's dependency tree (ffmpeg, libxml2,
# cups, pulse, …) or its unfixable advisories.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS rab
ARG MIN_NODE_VERSION
ARG MIN_LIBEXPAT_VERSION
WORKDIR /app
ENV NODE_ENV=production
# Alpine security updates, resolved from the base image's own stable v3.24 main/community repositories at build time
# (no edge repository is ever added; the floors gate below refuses any other repository line), then fail the build if the
# toolchain is somehow present.
RUN apk upgrade --no-cache \
  && test -z "$(apk info -e python3 make g++ gcc)"
# Security floors, after the last apk transaction: Node, the Alpine branch/repositories, Chromium ABSENT (fail closed if a
# future change pulls it back into the API image), and libexpat at or above its floor if anything installs it.
RUN --mount=type=bind,source=packages/rab-docker/rab/security-floors.sh,target=/tmp/security-floors.sh \
    --mount=type=bind,source=packages/rab-docker/rab/security-floors.env,target=/tmp/security-floors.env \
    sh /tmp/security-floors.sh /tmp/security-floors.env node alpine apk-absent:chromium apk-if-installed:libexpat
# Dependency scan (2026-10-30): every library finding Trivy reports for the base image (undici 6.27.0, tar, brace-expansion,
# ip-address, postcss-selector-parser) is inside the npm CLI the node image bundles. The runtime never runs npm or npx (the
# API, the Worker bundle, rab-migrate and rab-ops all start `node <file>`; npx is used by the build stage only, which keeps
# it), so the final stage drops the npm CLI. The Worker bundle image is built FROM this stage and inherits it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && test ! -e /usr/local/lib/node_modules/npm
# H1: application code and dependencies are ROOT-owned and not group/other-writable (COPY's default owner is 0:0). The
# runtime user `node` (uid/gid 1000, shipped by node:24-alpine) can read and execute them but never rewrite them, so a
# compromised process cannot persist by editing code it later re-imports. Only /app/storage (below) is writable by it.
# packages/rab-worker/dist stays in this image although the API never loads it: the Worker bundle image is built FROM
# this one (Dockerfile.worker-bundle has no build stage of its own), so this is where the Worker gets its code. It is
# about 0.8 MB, and none of it runs in the API process.
COPY --from=runtime-modules /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/rab-server/package.json ./packages/rab-server/package.json
COPY --from=build /app/packages/rab-server/dist ./packages/rab-server/dist
COPY --from=build /app/packages/rab-worker/package.json ./packages/rab-worker/package.json
COPY --from=build /app/packages/rab-worker/dist ./packages/rab-worker/dist
COPY --from=build /app/packages/rab-shared/package.json ./packages/rab-shared/package.json
COPY --from=build /app/packages/rab-shared/dist-cjs ./packages/rab-shared/dist-cjs
COPY --from=build /app/packages/rab-ui/package.json ./packages/rab-ui/package.json
COPY --from=build /app/packages/rab-ui/dist-cjs ./packages/rab-ui/dist-cjs
COPY --from=build /app/packages/rab-emails/package.json ./packages/rab-emails/package.json
COPY --from=build /app/packages/rab-emails/dist ./packages/rab-emails/dist
# Phase B P7: entry scripts are read+execute only (0555) and set in the COPY itself (no separate chmod layer). The API's
# command is api-prestart.sh; start.sh is kept only as a forwarder to it (it never migrates either).
COPY --chmod=0555 packages/rab-docker/rab/api-prestart.sh ./api-prestart.sh
COPY --chmod=0555 packages/rab-docker/rab/start.sh ./start.sh
COPY --chmod=0555 packages/rab-docker/rab/start-worker.sh ./start-worker.sh
# STORAGE_LOCAL_ROOT (default ./storage, i.e. /app/storage) is written at runtime, not copied in at build time: the one
# directory under /app the runtime user owns (0750). Then fail the build unless everything else under /app is root-owned,
# not group/other-writable, and free of compiled tests (symlinks are skipped: their own mode bits are meaningless).
RUN set -eu; \
    mkdir -p /app/storage && chown node:node /app/storage && chmod 0750 /app/storage; \
    test "$(stat -c '%u:%g' /app)" = 0:0; \
    bad="$(find /app -path /app/storage -prune -o ! -type l \( ! -user 0 -o ! -group 0 -o -perm /022 \) -print | head -n 20)"; \
    if [ -n "$bad" ]; then echo "FATAL: application files not root-owned or group/other-writable:"; echo "$bad"; exit 1; fi; \
    tests="$(find /app/packages \( -name __tests__ -o -name '*.spec.js' -o -name '*.test.js' \) -print | head -n 20)"; \
    if [ -n "$tests" ]; then echo "FATAL: compiled tests in the runtime image:"; echo "$tests"; exit 1; fi

USER node
EXPOSE 3000
# THE API NEVER MIGRATES (Phase B P7). api-prestart.sh refuses any migration/bootstrap credential in the API's
# environment, runs a read-only "no pending migrations" check as the restricted runtime role (PG_DATABASE_URL =
# crewflow_app), then execs main.js (which runs its own database boot gates). Migrations run only in the one-off
# rab-migrate service (deploy-prepare.js, migration-only credential from .env.migrate), which compose starts first. A real
# shell script rather than a command string, so platforms that do not shell-parse a command field behave the same.
CMD ["./api-prestart.sh"]
