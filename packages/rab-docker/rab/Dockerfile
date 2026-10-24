# syntax=docker/dockerfile:1

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS base
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

# Final stage — this is also the Dockerfile's last stage, which Render
# builds by default (see dockerfilePath in render.yaml).
FROM base AS rab
ENV NODE_ENV=production
# System Chromium for the worker's PDF jobs (shift roster + final timesheet).
# Playwright's own downloaded Chromium is glibc-only and does not run on
# Alpine/musl, so the image ships Alpine's Chromium and the renderer
# (packages/rab-worker/src/queues/rab-reports/render-pdf.util.ts) is pointed
# at it via env. One image, two commands: the API container carries it too
# but never loads it — clock-in/out never imports the renderer. Fonts:
# without them Chromium renders blank text.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-liberation font-noto
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium     CHROMIUM_NO_SANDBOX=true     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# node:24-alpine ships a non-root `node` user/group (uid/gid 1000) out of the
# box — reuse it rather than inventing one. --chown on every COPY avoids a
# separate `chown -R` layer (cheaper, and no root-owned intermediate layer).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/rab-server/package.json ./packages/rab-server/package.json
COPY --from=build --chown=node:node /app/packages/rab-server/dist ./packages/rab-server/dist
COPY --from=build --chown=node:node /app/packages/rab-worker/package.json ./packages/rab-worker/package.json
COPY --from=build --chown=node:node /app/packages/rab-worker/dist ./packages/rab-worker/dist
COPY --from=build --chown=node:node /app/packages/rab-shared/package.json ./packages/rab-shared/package.json
COPY --from=build --chown=node:node /app/packages/rab-shared/dist-cjs ./packages/rab-shared/dist-cjs
COPY --from=build --chown=node:node /app/packages/rab-ui/package.json ./packages/rab-ui/package.json
COPY --from=build --chown=node:node /app/packages/rab-ui/dist-cjs ./packages/rab-ui/dist-cjs
COPY --from=build --chown=node:node /app/packages/rab-emails/package.json ./packages/rab-emails/package.json
COPY --from=build --chown=node:node /app/packages/rab-emails/dist ./packages/rab-emails/dist
COPY --chown=node:node packages/rab-docker/rab/start.sh ./start.sh
COPY --chown=node:node packages/rab-docker/rab/start-worker.sh ./start-worker.sh
RUN chmod +x ./start.sh ./start-worker.sh
# STORAGE_LOCAL_ROOT (default ./storage, i.e. /app/storage) is written at
# runtime, not copied in at build time — /app itself stays root-owned (only
# the files explicitly --chown'd above aren't), so the non-root `node` user
# below can't mkdir a new directory directly under it without this.
RUN mkdir -p /app/storage && chown node:node /app/storage

USER node
EXPOSE 3000
# Runs migrations then execs main.js — kept as a real shell script rather
# than a dockerCommand string in render.yaml, since Render doesn't shell-
# parse that field the way plain `docker run` does with a CMD string
# (quoting/chaining silently breaks there instead).
CMD ["./start.sh"]
