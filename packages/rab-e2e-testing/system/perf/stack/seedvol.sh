#!/usr/bin/env bash
# A volume seed with the disposable marker set only for its duration (the production-mode API and Worker refuse a marked database).
set -uo pipefail
. /data/crewtest-lanef/env.sh
cd /data/crewtest-lanef/rab
cp /data/crewtest-lanef/seed-volume.mjs packages/rab-e2e-testing/system/perf/seed-volume.mjs
red() { sed -E 's#(postgres(ql)?|redis)://[^ "]+#<url>#g'; }
P=/data/crewtest-lanef/psql.sh
# The disposable marker exists only while a fixture seed runs: the production-mode API and Worker refuse a marked database.
bash $P -q -c "ALTER DATABASE crewflow SET crewflow.disposable_test_database = true"
t0=$(date +%s)
PERF_ADMIN_URL="$LF_ADMIN_URL" PERF_PG_CA="$PG_SSL_CA_CERT_PATH" node packages/rab-e2e-testing/system/perf/seed-volume.mjs "$@" 2>&1 | red | grep -v '^\s*at '
rc=${PIPESTATUS[0]}
bash $P -q -c "ALTER DATABASE crewflow RESET crewflow.disposable_test_database"
echo "seed rc=$rc $(( $(date +%s)-t0 ))s"; df -h /data | tail -1
