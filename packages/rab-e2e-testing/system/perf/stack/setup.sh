#!/usr/bin/env bash
# Lane F (M9): build the checkout on the test host. Before: git clone --depth 1 --branch main <repo> /data/crewtest-lanef/rab
set -uo pipefail
export PATH=/data/tools/node-v24.22.2-linux-x64/bin:$PATH TMPDIR=/data/crewtest-lanef/tmp NX_DAEMON=false NX_NO_CLOUD=true
cd /data/crewtest-lanef/rab
echo "node $(node -v)"
t0=$SECONDS
corepack enable --install-directory /data/crewtest-lanef/bin 2>/dev/null || true
export PATH=/data/crewtest-lanef/bin:$PATH
yarn install --immutable > ../logs/yarn-install.log 2>&1 || { echo YARN_FAIL; tail -30 ../logs/yarn-install.log; exit 1; }
echo "install $((SECONDS-t0))s"
npx nx run-many -t build -p rab-shared,rab-emails,rab-ui > ../logs/build-libs.log 2>&1 || { echo LIBS_FAIL; tail -30 ../logs/build-libs.log; exit 1; }
npx nx build rab-server > ../logs/build-server.log 2>&1 || { echo SERVER_FAIL; tail -30 ../logs/build-server.log; exit 1; }
npx nx build rab-worker > ../logs/build-worker.log 2>&1 || { echo WORKER_FAIL; tail -30 ../logs/build-worker.log; exit 1; }
echo "built $((SECONDS-t0))s"; df -h /data | tail -1
echo SETUP_DONE
