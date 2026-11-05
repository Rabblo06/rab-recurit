# O3 real-container tests (Agent 5), TEST-ONLY WORKAROUND, built locally, never pushed, labelled in every result:
#   docker build -f Dockerfile --build-arg BASE=<probe image> .
#
# Defect found by T8a (2026-11-05): the Worker's bounded schema wait (packages/rab-worker/src/main.ts, waitForWorkerSchema)
# calls checkSchemaCompatibility WITHOUT readUpgradeEvidence, so upgradeEvidence stays undefined, the C3 Worker relaxation
# (schema-compatibility.ts, workerRelaxed) can never apply, and the Worker refuses an in-order pending tail before it reaches
# gate 7 (which does pass readUpgradeEvidence, database-boot-gates.ts). This layer adds exactly that one option to the
# compiled call, the same expression gate 7 uses, so the rest of the "Worker starts too" path can be measured. The product
# fix belongs to the Worker owner.
ARG BASE
FROM ${BASE}
USER root
RUN f=/app/packages/rab-worker/dist/main.js \
 && test "$(grep -c "^                    label: 'worker process',$" "$f")" = 1 \
 && ! grep -q 'readUpgradeEvidence' "$f" \
 && sed -i "s/^                    label: 'worker process',$/                    label: 'worker process',\n                    readUpgradeEvidence: () => (0, database_boot_gates_1.readUpgradeEvidence)((sql, params) => dataSource.query(sql, params), expected),/" "$f" \
 && test "$(grep -c 'readUpgradeEvidence: () => (0, database_boot_gates_1.readUpgradeEvidence)' "$f")" = 1 \
 && node --check "$f" \
 && chown root:root "$f" && chmod 644 "$f"
USER node
