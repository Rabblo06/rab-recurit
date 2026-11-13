# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The Dockerfile frontend is pinned by its OCI index digest (H5 release gate refuses an unpinned frontend). Verified
# 2026-11-03 with `docker buildx imagetools inspect docker/dockerfile:1` (the :1 tag resolves to this digest).

# Security floors (H1): the minimum Node and libexpat versions, and the only Alpine branch apk may resolve from,
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
# H3: type declarations (*.d.ts), source maps and TypeScript build-info files are build-only output as well: nothing loads
# them at runtime, and a source map can embed original source. They are deleted from the same dist folders (only .d.ts is
# emitted today, about 4.9 MB; the final stage refuses any source map that comes back). packages/rab-ui is no longer in
# the list: no runtime file imports @rab/ui (it is a front-end library), so the runtime stage does not copy it.
RUN set -eu; \
    dists="packages/rab-server/dist packages/rab-worker/dist packages/rab-shared/dist-cjs packages/rab-emails/dist"; \
    for d in $dists; do test -d "$d"; done; \
    find $dists -type d \( -name __tests__ -o -name __mocks__ -o -name __fixtures__ \) -prune -exec rm -rf {} +; \
    find $dists -type f \( -name '*.spec.*' -o -name '*.test.*' -o -name 'jest-*' -o -name 'test-helpers.*' \) -delete; \
    find $dists -type f \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -name '*.map' -o -name '*.tsbuildinfo' \) -delete; \
    left="$(find $dists \( -name __tests__ -o -name __mocks__ -o -name __fixtures__ -o -name '*.spec.*' -o -name '*.test.*' -o -name 'jest-*' -o -name 'test-helpers.*' \) -print)"; \
    if [ -n "$left" ]; then echo "FATAL: test files remain in runtime dist folders:"; echo "$left"; exit 1; fi; \
    rc=0; refs="$(grep -rlE "(require\(|from |import\()[[:space:]]*['\"][^'\"]*(/__tests__/|/__mocks__/|/__fixtures__/|\.spec(\.js)?['\"]|\.test(\.js)?['\"]|/test-helpers(\.js)?['\"]|/jest-[A-Za-z0-9-]+(\.js)?['\"])" $dists)" || rc=$?; \
    if [ "$rc" -gt 1 ]; then echo "FATAL: the import scan itself failed (grep exit $rc)"; exit 1; fi; \
    if [ -n "$refs" ]; then echo "FATAL: runtime code imports a removed test file:"; echo "$refs"; exit 1; fi; \
    find $dists ! -type l -perm /022 -exec chmod go-w {} +

# H3: the runtime node_modules is the PRODUCTION dependency closure of @rab/server alone, not the deps stage's whole
# workspace install (which also holds the front end's, the e2e suite's and every test and build package: Nx, TypeScript,
# Jest, Vite/esbuild — whose nested Go binaries were 1 CRITICAL + ~25 HIGH in the 2026-10-30 scan — react-email's preview
# server, the Playwright test runner, ...). `yarn workspaces focus @rab/server --production` prunes the deps stage's install
# in place, from the same lockfile and the yarn cache already in that layer, keeping only @rab/server's `dependencies` and,
# transitively, those of the workspaces it depends on (@rab/shared, @rab/emails); the lockfile is verified unchanged.
# The Worker-only packages (the native PDF renderer's closure) are NOT in it: the `worker-modules` stage below adds exactly
# the Worker's extra packages. The final stage proves the combined closure (runtime-deps.cjs: every compiled import of the
# API and the Worker resolves, no build or test tool is present), so a package the runtime needs but the manifests
# misclassify fails the BUILD.
# H1: any group/other write bit a package tarball shipped with is cleared here (only the offending entries are touched,
# so this stage does not rewrite the whole tree); the final stage then re-verifies the whole of /app.
FROM deps AS runtime-modules
RUN set -eu; \
    lock="$(sha256sum yarn.lock)"; \
    yarn workspaces focus @rab/server --production; \
    test "$(sha256sum yarn.lock)" = "$lock"; \
    nested="$(find packages -mindepth 2 -maxdepth 2 -name node_modules -print)"; \
    if [ -n "$nested" ]; then echo "FATAL: the production install put packages under a workspace, which the runtime stage does not copy:"; echo "$nested"; exit 1; fi; \
    find node_modules ! -type l -perm /022 -exec chmod go-w {} +

# H3 (O1 one image): the Worker's production dependency closure, resolved from the committed manifests and lockfile with
# the same pinned Node image. Lifecycle scripts are disabled: nothing is built here, and the packages the Worker adds must
# not need building (runtime-deps.cjs worker-delta refuses one that does, and refuses unless every package of the API tree
# is in the Worker tree at the same path and version). Only that DELTA (the native PDF renderer's closure, about 55
# packages) reaches the final stage, on top of the API tree above.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS worker-modules
WORKDIR /app
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
RUN --mount=type=bind,from=runtime-modules,source=/app/node_modules,target=/api/node_modules \
    --mount=type=bind,source=packages/rab-docker/rab/runtime-deps.cjs,target=/tmp/runtime-deps.cjs \
    set -eu; \
    lock="$(sha256sum yarn.lock)"; \
    corepack enable; \
    YARN_ENABLE_SCRIPTS=false yarn workspaces focus @rab/worker --production; \
    test "$(sha256sum yarn.lock)" = "$lock"; \
    nested="$(find packages -mindepth 2 -maxdepth 2 -name node_modules -print)"; \
    if [ -n "$nested" ]; then echo "FATAL: the production install put packages under a workspace:"; echo "$nested"; exit 1; fi; \
    node /tmp/runtime-deps.cjs worker-delta /api/node_modules /app/node_modules /worker-delta; \
    test -d /worker-delta/node_modules; \
    find /worker-delta ! -type l -perm /022 -exec chmod go-w {} +

# Final stage = THE image (O1, owner decision "exactly like Twenty"): ONE image runs every Crewflow process, chosen by
# command: rab-api (the default CMD, ./api-prestart.sh), rab-worker (`node packages/rab-worker/dist/main.js`), and the
# one-off rab-migrate and the owner-login one-off commands. It is also the Dockerfile's last stage,
# which Docker builds by default when no `--target` is given (OpenShip and Render cannot pass one): keep it last.
# The same pinned Node image as `base`, WITHOUT base's native build toolchain (python3/make/g++/gcc): those are build-only
# (image scan 2026-10-30: python3 3.14.8 = 4 CRITICAL) and the runtime compiles nothing. Keep the digest in step with `base`.
#
# H2/P5: NO browser, system fonts or PDF settings: since P5 the Worker renders PDFs natively (@react-pdf/renderer, pure
# JavaScript, vendored fonts), and the API only serves PDFs the Worker already stored. The image carries none of
# Chromium's dependency tree (ffmpeg, libxml2, cups, pulse, …) or its unfixable advisories; it re-checks
# apk-absent:chromium, a build-time guard refuses every OS package of the former browser stack by name, and the image gate
# fails on any browser-stack package (policy.json forbidden_apk/_npm).
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS rab
ARG MIN_NODE_VERSION
ARG MIN_LIBEXPAT_VERSION
WORKDIR /app
ENV NODE_ENV=production
# Alpine security updates, resolved from the base image's own stable v3.24 main/community repositories at build time
# (no edge repository is ever added; the floors gate below refuses any other repository line), plus tini, the image's
# ENTRYPOINT (reaps orphans and forwards signals for every command), then fail the build if the toolchain is somehow
# present. tini is the only OS package added.
RUN apk upgrade --no-cache \
  && apk add --no-cache tini \
  && test -z "$(apk info -e python3 make g++ gcc)"
# Security floors, after the last apk transaction: Node, the Alpine branch/repositories, Chromium ABSENT (fail closed if a
# future change pulls it back into the image), and libexpat at or above its floor if anything installs it.
RUN --mount=type=bind,source=packages/rab-docker/rab/security-floors.sh,target=/tmp/security-floors.sh \
    --mount=type=bind,source=packages/rab-docker/rab/security-floors.env,target=/tmp/security-floors.env \
    sh /tmp/security-floors.sh /tmp/security-floors.env node alpine apk-absent:chromium apk-if-installed:libexpat
# P5 guard: no OS package of the former browser stack may come back by any route (Chromium and the libraries only it pulled
# in: ffmpeg, libsndfile, alsa-lib, glib, libxml2, cups-libs, cjson, ...). The image gate's `fs` check enforces the same
# names from policy.json (roles.image.forbidden_apk) on the exported filesystem.
RUN set -eu; \
    test "$(apk info -e tini)" = tini; test -x /sbin/tini; \
    back="$(apk info -e chromium chromium-swiftshader chromium-lang nss nspr ffmpeg-libavcodec ffmpeg-libavformat \
      ffmpeg-libavutil ffmpeg-libswresample ffmpeg-libswscale libsndfile alsa-lib libpulse glib libxml2 cups-libs cjson \
      librist mesa-gbm libdrm at-spi2-core libx11 libxcb dbus-libs harfbuzz fontconfig ttf-liberation font-noto || true)"; \
    if [ -n "$back" ]; then echo "FATAL: browser-stack packages in the image:"; echo "$back"; exit 1; fi; \
    for p in /usr/lib/chromium /usr/bin/chromium /usr/bin/chromium-browser; do test ! -e "$p"; done
# Dependency scan (2026-10-30): every library finding Trivy reports for the base image (undici 6.27.0, tar, brace-expansion,
# ip-address, postcss-selector-parser) is inside the npm CLI the node image bundles. The runtime never runs npm or npx (the
# API, the Worker bundle, rab-migrate and the one-off commands all start `node <file>`; npx is used by the build stage only,
# which keeps it), so the final stage drops the npm CLI.
# H3: the other package managers the node image ships go too: Yarn 1 (/opt/yarn-v*, the yarn/yarnpkg links) and Corepack
# (the yarn/pnpm launcher). Dependencies are installed in the build stages only; nothing at runtime installs, resolves or
# downloads a package, so a package manager in the runtime image is unused build tooling.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && test ! -e /usr/local/lib/node_modules/npm && test ! -e /usr/local/lib/node_modules/corepack \
  && test -z "$(ls -d /opt/yarn-v* 2>/dev/null)" \
  && for b in npm npx corepack yarn yarnpkg pnpm pnpx; do if command -v "$b" >/dev/null 2>&1; then echo "FATAL: package manager $b in the runtime image"; exit 1; fi; done
# H1: application code and dependencies are ROOT-owned and not group/other-writable (COPY's default owner is 0:0). The
# runtime user `node` (uid/gid 1000, shipped by node:24-alpine) can read and execute them but never rewrite them, so a
# compromised process cannot persist by editing code it later re-imports. Only /app/storage (below) is writable by it.
# O1: the API and the Worker share this one tree. The Worker-only packages (the native PDF renderer's closure) are the
# worker-modules DELTA, copied on top of the API's production tree; they are present in the API's filesystem but never
# imported by the API process (the import-graph checks of the image gate are the guard).
COPY --from=runtime-modules /app/node_modules ./node_modules
COPY --from=worker-modules /worker-delta/node_modules/ ./node_modules/
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/rab-server/package.json ./packages/rab-server/package.json
COPY --from=build /app/packages/rab-server/dist ./packages/rab-server/dist
COPY --from=build /app/packages/rab-worker/package.json ./packages/rab-worker/package.json
COPY --from=build /app/packages/rab-worker/dist ./packages/rab-worker/dist
COPY --from=build /app/packages/rab-shared/package.json ./packages/rab-shared/package.json
COPY --from=build /app/packages/rab-shared/dist-cjs ./packages/rab-shared/dist-cjs
COPY --from=build /app/packages/rab-emails/package.json ./packages/rab-emails/package.json
COPY --from=build /app/packages/rab-emails/dist ./packages/rab-emails/dist
# Entry scripts are read+execute only (0555) and set in the COPY itself (no separate chmod layer). The API's command is
# api-prestart.sh; start.sh is kept only as a forwarder to it. The Worker needs no script: its command is
# `node packages/rab-worker/dist/main.js`.
COPY --chmod=0555 packages/rab-docker/rab/api-prestart.sh ./api-prestart.sh
COPY --chmod=0555 packages/rab-docker/rab/start.sh ./start.sh
# The Worker's per-instance jobs health check (compose: `env CREWFLOW_PROVISIONER_ENABLED=false node
# /opt/crewflow-bundle/worker-bundle-health.cjs`), at the path every compose file and gate already uses. 0444 file, 0755
# directory (set below), root-owned: code the runtime user can read but never rewrite.
COPY --chown=root:root --chmod=0444 packages/rab-docker/rab/worker-bundle/worker-bundle-health.cjs /opt/crewflow-bundle/
# STORAGE_LOCAL_ROOT (default ./storage, i.e. /app/storage) is written at runtime, not copied in at build time: the one
# directory under /app the runtime user owns (0750). Then fail the build unless everything else under /app is root-owned,
# not group/other-writable, and free of compiled tests (symlinks are skipped: their own mode bits are meaningless).
# Security review H1-M1: Node's CommonJS loader also searches $HOME/.node_modules and $HOME/.node_libraries
# (require('module').globalPaths), and node:24-alpine ships /home/node owned by node (2755). A process running as node
# could plant e.g. $HOME/.node_modules/pg-native, which TypeORM's Postgres driver tries to load on every start: persistent
# code execution after a restart. /home/node therefore becomes root-owned 0555 (nothing at runtime writes HOME: no npm or
# yarn, no browser; the Worker runs with HOME=/nonexistent from compose). The module-paths gate after `USER node` below
# proves no module search path is writable by the runtime user. No setuid/setgid file may remain.
# The Worker's jobs directories exist as mount points (compose mounts a tmpfs on each): /tmp/crewflow-jobs (0700, 1000)
# for its TMPDIR / XDG caches and /run/crewflow-health/jobs (0755, 1000) for its per-instance heartbeat.
RUN set -eu; \
    mkdir -p /app/storage && chown node:node /app/storage && chmod 0750 /app/storage; \
    chown root:root /home/node && chmod 0555 /home/node; \
    chmod 0755 /opt/crewflow-bundle && test "$(stat -c %a /opt/crewflow-bundle/worker-bundle-health.cjs)" = 444; \
    test "$(id -u node)" = 1000; test "$(id -g node)" = 1000; \
    mkdir -p /tmp/crewflow-jobs /run/crewflow-health/jobs; \
    chown 1000:1000 /tmp/crewflow-jobs /run/crewflow-health/jobs; \
    chmod 0700 /tmp/crewflow-jobs; chmod 0755 /run/crewflow-health /run/crewflow-health/jobs; \
    test -f /app/packages/rab-server/dist/main.js; \
    test -f /app/packages/rab-worker/dist/main.js; \
    test -f /app/packages/rab-server/dist/database/typeorm/workspace-schema/provision-workspace-schema.js; \
    test -d /app/packages/rab-shared/dist-cjs; test -d /app/packages/rab-emails/dist; \
    for f in /app/.env /app/packages/rab-worker/.env /app/packages/rab-worker/.env.provisioner /app/packages/rab-server/.env; do test ! -e "$f"; done; \
    test -z "$(find /app -path /app/node_modules -prune -o -name '.env*' -print)"; \
    suid="$(find / -xdev -type f -perm /6000 -print | head -n 20)"; \
    if [ -n "$suid" ]; then echo "FATAL: setuid/setgid files in the runtime image:"; echo "$suid"; exit 1; fi; \
    test "$(stat -c '%u:%g' /app)" = 0:0; \
    bad="$(find /app -path /app/storage -prune -o ! -type l \( ! -user 0 -o ! -group 0 -o -perm /022 \) -print | head -n 20)"; \
    if [ -n "$bad" ]; then echo "FATAL: application files not root-owned or group/other-writable:"; echo "$bad"; exit 1; fi; \
    tests="$(find /app/packages \( -name __tests__ -o -name '*.spec.js' -o -name '*.test.js' \) -print | head -n 20)"; \
    if [ -n "$tests" ]; then echo "FATAL: compiled tests in the runtime image:"; echo "$tests"; exit 1; fi; \
    maps="$(find /app/packages \( -name '*.map' -o -name '*.tsbuildinfo' \) -print | head -n 20)"; \
    if [ -n "$maps" ]; then echo "FATAL: source maps or TypeScript build-info in the runtime image:"; echo "$maps"; exit 1; fi
# H3 runtime-dependency gate (packages/rab-docker/rab/runtime-deps.cjs, bind-mounted, never shipped), ONE check for the
# one image (the union of the former API and Worker checks, so stricter for the API): every bare import in the code this
# image runs (Worker, server, shared and emails dist) resolves with Node's own resolver, and no build or test tool, browser
# driver (playwright, playwright-core, chromium-bidi) or SWC compiler is anywhere in node_modules. D5/T2 + review L-4: the
# whole '@swc/*' and '@swc-node/*' scopes stay banned with ONE exact exception, the runtime helper library @swc/helpers
# (Apache-2.0, required by fontkit, a dependency of the native renderer), named by --allow. The native renderer and its
# vendored fonts must be present (the fonts are copied next to the compiled native module by the rab-worker build), and
# every dependency is root-owned and not group/other-writable. (prettier is NOT on the list: it is a declared runtime
# dependency of @react-email/render and of nest-commander's completion helper, so it is in the production closure.)
RUN --mount=type=bind,source=packages/rab-docker/rab/runtime-deps.cjs,target=/tmp/runtime-deps.cjs \
    set -eu; \
    node /tmp/runtime-deps.cjs check /app/node_modules \
      --scan /app/packages/rab-worker/dist /app/packages/rab-server/dist /app/packages/rab-shared/dist-cjs /app/packages/rab-emails/dist \
      --forbid typescript nx '@nx/*' jest '@jest/*' ts-jest ts-node ts-node-dev tsx vite esbuild '@esbuild/*' eslint \
        '@swc/*' '@swc-node/*' \
        webpack react-email @playwright/test supertest aws-sdk-client-mock @nestjs/testing concurrently wait-on \
        playwright playwright-core chromium-bidi \
      --allow @swc/helpers; \
    test -f /app/node_modules/@react-pdf/renderer/package.json; \
    for f in LiberationSans-Regular.ttf LiberationSans-Bold.ttf OFL.txt fonts.sha256; do test -f "/app/packages/rab-worker/dist/queues/rab-reports/native/assets/fonts/$f"; done; \
    bad="$(find /app/node_modules ! -type l \( ! -user 0 -o ! -group 0 -o -perm /022 \) -print | head -n 20)"; \
    if [ -n "$bad" ]; then echo "FATAL: dependencies not root-owned or group/other-writable:"; echo "$bad"; exit 1; fi

# O1: the image's default user is the non-root `node` (1000:1000) for EVERY command; no process in this image ever starts
# as root (the former Worker image ended `USER root` for its launcher, now retired).
USER node
# Security review H1-M1 gate, run as the runtime user itself, once with the API's HOME (/home/node) and once with the
# Worker's (HOME=/nonexistent, as compose sets it): no Node module search path (globalPaths including $HOME/.node_modules
# and $HOME/.node_libraries, NODE_PATH, and the node_modules lookup chain of every entry point) may be writable or
# creatable, and planting $HOME/.node_modules/pg-native must fail.
RUN --mount=type=bind,source=packages/rab-docker/rab/module-paths-gate.cjs,target=/tmp/module-paths-gate.cjs \
    node /tmp/module-paths-gate.cjs \
  && HOME=/nonexistent node /tmp/module-paths-gate.cjs
EXPOSE 3000
# tini is PID 1's child or PID 1 itself: with `-s` it registers as a subreaper when compose's own init (`init: true`) is PID
# 1, so orphans are reaped and signals forwarded either way. No image HEALTHCHECK: each service's check lives in compose
# (the API's /healthz, the Worker's per-instance heartbeat), because one image-level check would apply to every command.
ENTRYPOINT ["/sbin/tini", "-s", "--"]
# The default command is the API: api-prestart.sh (env refusals, the runtime-isolation check, the owner-login migration
# child when CREWFLOW_MIGRATE_ON_START=true or the read-only code<->schema compatibility check otherwise, then main.js).
# The Worker runs the SAME image with `node packages/rab-worker/dist/main.js`. A real shell script rather than a command
# string, so platforms that do not shell-parse a command field behave the same.
CMD ["./api-prestart.sh"]
