# O3 real-container tests (Agent 5), TEST-ONLY: the image under test plus ONE extra migration (o3-tests/migration/<variant>).
# Built locally, never pushed:  docker build -f Dockerfile --build-arg BASE=<image> --build-arg VARIANT=broken|fixed .
ARG BASE
FROM ${BASE}
ARG VARIANT
COPY --chown=1000:1000 ${VARIANT}/1786721999001-O3tUpgradeProbe.js /app/packages/rab-server/dist/database/typeorm/core/migrations/1786721999001-O3tUpgradeProbe.js
