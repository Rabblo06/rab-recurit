# O3 real-container tests (Agent 5), TEST-ONLY: the FIXED probe image plus one SLOW migration (T10), approved by name in the
# compiled N1 list as a real release would. Built locally, never pushed:
#   docker build -f Dockerfile --build-arg BASE=<fixed probe image tag> .
ARG BASE
FROM ${BASE}
COPY --chown=1000:1000 1786721999002-O3tSlowProbe.js /app/packages/rab-server/dist/database/typeorm/core/migrations/1786721999002-O3tSlowProbe.js
USER root
RUN f=/app/packages/rab-server/dist/database/typeorm/core/production-migration-approval.js \
 && grep -qx 'exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(\["O3tUpgradeProbe1786721999001"\]);' "$f" \
 && sed -i 's/^exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(\["O3tUpgradeProbe1786721999001"\]);$/exports.PRODUCTION_APPROVED_MIGRATIONS = new Set(["O3tUpgradeProbe1786721999001", "O3tSlowProbe1786721999002"]);/' "$f" \
 && grep -q '"O3tSlowProbe1786721999002"' "$f" \
 && chown root:root "$f" && chmod 644 "$f"
USER node
