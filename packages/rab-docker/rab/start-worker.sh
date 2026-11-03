#!/bin/sh
# RETIRED (Docker hardening H2, security review H2-L1). This script used to start the Worker from the shared/API image
# (`node packages/rab-worker/dist/main.js`). Since H2 that image has no Chromium, so a Worker started here could not
# render any PDF and would fail late, job by job. It now refuses to start instead (fail closed).
#
# The supported Worker is the bundle image: packages/rab-docker/rab/Dockerfile.worker-bundle (built FROM the API image;
# adds Chromium, the security floors and the launcher), started by its own ENTRYPOINT/CMD
# (tini -> node /opt/crewflow-bundle/start-worker-bundle.cjs). No committed compose file, CI job or test uses this script.
echo "start-worker.sh: REFUSED - the Worker no longer runs from the API image (it has no Chromium for PDF jobs). Build and run packages/rab-docker/rab/Dockerfile.worker-bundle instead (its default command starts the Worker)." >&2
exit 1
