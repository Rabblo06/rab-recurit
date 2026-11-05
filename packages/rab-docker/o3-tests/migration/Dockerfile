# O3 real-container tests (Agent 5), TEST-ONLY: the image under test plus ONE extra migration (o3-tests/migration/<variant>).
# Built locally, never pushed:  docker build -f Dockerfile --build-arg BASE=<image> --build-arg VARIANT=broken|fixed .
#
# A real release that ships a new migration also approves it for production by name (production-migration-approval.ts,
# PRODUCTION_APPROVED_MIGRATIONS, a reviewed change): with approval mode none that list is THE gate on an existing
# database (locked-migration-runner.ts, 'none-mode', ST-3). The test-only build therefore does the same for its one probe
# migration, in the compiled list, and nothing else. Without it the upgrade is refused (65, nothing applied) before the
# probe ever runs, so the C3 upgrade-failure path would never be reached.
ARG BASE
FROM ${BASE}
ARG VARIANT
COPY --chown=1000:1000 ${VARIANT}/1786721999001-O3tUpgradeProbe.js /app/packages/rab-server/dist/database/typeorm/core/migrations/1786721999001-O3tUpgradeProbe.js
USER root
RUN f=/app/packages/rab-server/dist/database/typeorm/core/production-migration-approval.js \
 && grep -qx 'exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(\[\]);' "$f" \
 && sed -i 's/^exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(\[\]);$/exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(["O3tUpgradeProbe1786721999001"]);/' "$f" \
 && grep -qx 'exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(\["O3tUpgradeProbe1786721999001"\]);' "$f" \
 && chown root:root "$f" && chmod 644 "$f"
USER node
