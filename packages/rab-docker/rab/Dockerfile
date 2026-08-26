# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/rab-server/package.json ./packages/rab-server/package.json
COPY --from=build /app/packages/rab-server/dist ./packages/rab-server/dist
COPY --from=build /app/packages/rab-shared/package.json ./packages/rab-shared/package.json
COPY --from=build /app/packages/rab-shared/dist-cjs ./packages/rab-shared/dist-cjs
COPY --from=build /app/packages/rab-ui/package.json ./packages/rab-ui/package.json
COPY --from=build /app/packages/rab-ui/dist-cjs ./packages/rab-ui/dist-cjs
COPY --from=build /app/packages/rab-emails/package.json ./packages/rab-emails/package.json
COPY --from=build /app/packages/rab-emails/dist ./packages/rab-emails/dist

EXPOSE 3000
# render.yaml overrides this via dockerCommand (runs migrations first);
# this CMD is the fallback for `docker run` locally.
CMD ["node", "packages/rab-server/dist/main.js"]
