#!/usr/bin/env bash
# Sourced by the other scripts: the URLs and secrets of the disposable stack, read from files generated on the host (never printed).
# sourced: builds the URLs from the secret files; prints nothing
W=/data/crewtest-lanef
export PATH=/data/tools/node-v24.22.2-linux-x64/bin:$PATH TMPDIR=$W/tmp
LF_SU="$(cat $W/secrets/su)"; LF_OWNER="$(cat $W/secrets/owner)"
export LF_ADMIN_URL="postgres://lanef_admin:${LF_SU}@127.0.0.1:15490/crewflow"
export LF_OWNER_URL="postgres://crewflow_owner:${LF_OWNER}@127.0.0.1:15490/crewflow"
export LF_APP_SECRET="$(cat $W/secrets/app_secret)"
unset LF_SU LF_OWNER
