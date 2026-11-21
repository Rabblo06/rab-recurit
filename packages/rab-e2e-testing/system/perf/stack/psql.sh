#!/usr/bin/env bash
# Superuser psql inside the disposable crewtest-lanef-pg container (local socket). Extra arguments go to psql; a later -d wins.
# usage: bash psql.sh "<sql>"  (superuser, inside the crewtest-lanef-pg container, local socket)
docker exec -i -u postgres crewtest-lanef-pg sh -c 'PGPASSWORD="$(cat /run/lanef/su)" psql -X -h /var/run/postgresql -U lanef_admin -d crewflow -v ON_ERROR_STOP=1 "$@"' -- "$@"
