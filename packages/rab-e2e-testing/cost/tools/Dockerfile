# Load generator image for the crewflow-cost harness (autocannon 8.0.0 pinned by package-lock.json). Built by
# scripts/run.sh as crewflow-cost/loadgen:<content hash>; runs on crewflow-cost-net with no bind mounts.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /tools
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY ac.js ./ac.js
USER node
ENTRYPOINT ["node", "/tools/ac.js"]
