# syntax=docker/dockerfile:1

FROM node:26-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070 AS base
# python3/make/g++: fallback native build toolchain for deps that ship no
# prebuilt musl binary (e.g. bcrypt, landing in M1).
RUN apk add --no-cache python3 make g++ \
  && corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages/rab-server/package.json packages/rab-server/package.json
COPY packages/rab-shared/package.json packages/rab-shared/package.json
COPY packages/rab-ui/package.json packages/rab-ui/package.json
COPY packages/rab-front/package.json packages/rab-front/package.json
COPY packages/rab-emails/package.json packages/rab-emails/package.json
COPY packages/rab-e2e-testing/package.json packages/rab-e2e-testing/package.json
COPY packages/rab-utils/package.json packages/rab-utils/package.json
RUN yarn install --immutable

FROM deps AS build
COPY . .
RUN npx nx run-many -t build -p rab-server,rab-shared,rab-ui

# Final stage — this is also the Dockerfile's last stage, which Render
# builds by default (see dockerfilePath in render.yaml).
FROM base AS rab
ENV NODE_ENV=production
# System Chromium for the worker's PDF jobs (shift roster + final timesheet).
# Playwright's own downloaded Chromium is glibc-only and does not run on
# Alpine/musl, so the image ships Alpine's Chromium and the renderer
# (queue-worker/reports/render-pdf.util.ts) is pointed at it via env. One image,
# two commands: the API container carries it too but never loads it — clock-in/out
# never imports the renderer. Fonts: without them Chromium renders blank text.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-liberation font-noto
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium     CHROMIUM_NO_SANDBOX=true     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# node:24-alpine ships a non-root `node` user/group (uid/gid 1000) out of the
# box — reuse it rather than inventing one. --chown on every COPY avoids a
# separate `chown -R` layer (cheaper, and no root-owned intermediate layer).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/rab-server/package.json ./packages/rab-server/package.json
COPY --from=build --chown=node:node /app/packages/rab-server/dist ./packages/rab-server/dist
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
