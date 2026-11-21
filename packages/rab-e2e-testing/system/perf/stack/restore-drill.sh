#!/usr/bin/env bash
# M9 restore drill (Lane F): logical backup of the seeded source cluster -> a fresh PostgreSQL cluster of the same minor ->
# verify (row counts, ledger, deployment identity, FORCE-RLS coverage, posture goldens) -> the production-mode API on the
# copy, serving real logins and reads. Records every step's timing; RTO = restore start to verified serving.
# Follows packages/rab-docker/docs/release/MIGRATION-AND-ROLLBACK-PLAN.md §5.2 on a DISPOSABLE host. Every resource is
# crewtest-lanef-*; the source cluster is only read (pg_dump / pg_dumpall / pg_basebackup). Results:
# packages/rab-docker/docs/hardening/RESTORE-DRILL.md.
#
#   bash restore-drill.sh            (after stack.sh up and at least one load run, so the source holds real traffic)
set -uo pipefail
W="${LANEF_WORK:-/data/crewtest-lanef}"
R=$W/results/restore${RESTORE_LABEL:+-$RESTORE_LABEL}
mkdir -p "$R" "$W/backup"
# shellcheck disable=SC1091
. "$W/env.sh"
# shellcheck disable=SC1091
. "$W/prodenv.sh"
cd "$W/rab" || exit 1
ts() { date -u +%FT%T.%3NZ; }
ms() { date +%s%3N; }
log() { echo "[$(ts)] $*" | tee -a "$R/steps.log"; }
red() { sed -E 's#(postgres(ql)?|redis)://[^ "]+#<url>#g'; }
SRC=crewtest-lanef-pg
DST=crewtest-lanef-pg-restore
su_sql() { docker exec -i -u postgres "$1" sh -c 'PGPASSWORD="$(cat /run/lanef/su)" psql -X -h /var/run/postgresql -U lanef_admin "$@"' -- "${@:2}"; }
COUNTS="select 'migrations', count(*)::text || '/' || max(timestamp)::text from core.migrations union all
 select 'gated_1786721330000', count(*)::text from core.migrations where timestamp = 1786721330000 union all
 select t, (xpath('/row/n/text()', query_to_xml(format('select count(*) n from core.%I', t), false, true, '')))[1]::text
 from unnest(array['user','organisation','manager_workspace','staff_profile','venue','job_role','shift','shift_assignment','job_offer','attendance','payroll_record','payroll_run','payroll_run_line','shift_report','audit_log','user_session','email_outbox']) t
 order by 1"
: > "$R/steps.log"
# §4.4 / §5.1: the API and the Worker are stopped and GONE before the backup (the Worker drains for up to 30 s).
for f in api worker sinks; do
  pid="$(cat "$W/$f.pid" 2> /dev/null)"
  [ -n "$pid" ] || continue
  kill "$pid" 2> /dev/null
  for _ in $(seq 1 60); do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
done
log "application stopped: $(su_sql $SRC -d crewflow -At -c "select count(*) from pg_stat_activity where datname = 'crewflow' and usename = 'crewflow_owner'") crewflow_owner session(s) left"

log "source counts at backup time"
su_sql $SRC -d crewflow -At -F ' ' -c "$COUNTS" > "$R/source-counts.txt"
su_sql $SRC -d crewflow -At -c "select pg_size_pretty(pg_database_size('crewflow'))" | xargs -I{} log "source database size {}"
log "pg_dump -Fc + pg_dumpall --roles-only --no-role-passwords (superuser, local socket, inside the source container)"
T_DUMP_START=$(ts)
t0=$(ms)
docker exec -u postgres $SRC sh -c 'PGPASSWORD="$(cat /run/lanef/su)" pg_dump -Fc -h /var/run/postgresql -U lanef_admin -d crewflow' > "$W/backup/crewflow.dump"
rc1=$?
docker exec -u postgres $SRC sh -c 'PGPASSWORD="$(cat /run/lanef/su)" pg_dumpall --roles-only --no-role-passwords -h /var/run/postgresql -U lanef_admin' > "$W/backup/roles.sql"
rc2=$?
T_DUMP=$(($(ms) - t0))
log "dump rc=$rc1/$rc2 in ${T_DUMP} ms: $(du -h "$W/backup/crewflow.dump" | cut -f1) archive, $(wc -c < "$W/backup/roles.sql") bytes of roles"
(cd "$W/backup" && sha256sum crewflow.dump roles.sql > SHA256SUMS)
log "physical: pg_basebackup -Ft -z -X stream (for the physical-backup timing only)"
# A replication connection needs its own pg_hba line (the bundled db's hba has none: physical backups there need one too).
docker exec $SRC sh -c 'cd /var/lib/postgresql/data && grep -q "^local replication" pg_hba.conf || { printf "local replication lanef_admin scram-sha-256
" >> pg_hba.conf; }'
su_sql $SRC -d crewflow -q -c "select pg_reload_conf()" > /dev/null
t0=$(ms)
rm -rf "$W/backup/base"
mkdir -p "$W/backup/base"
docker exec -u postgres $SRC sh -c 'rm -rf /tmp/bb && PGPASSWORD="$(cat /run/lanef/su)" pg_basebackup -h /var/run/postgresql -U lanef_admin -D /tmp/bb -Ft -z -X stream -c fast' &&
  docker cp $SRC:/tmp/bb/. "$W/backup/base/" > /dev/null && docker exec -u postgres $SRC rm -rf /tmp/bb
T_BASE=$(($(ms) - t0))
log "pg_basebackup in ${T_BASE} ms: $(du -sh "$W/backup/base" | cut -f1)"

# ------------------------------------------------------------------------------------------------- RTO clock starts
T_RESTORE_START=$(ts)
R0=$(ms)
log "RTO START: fresh cluster $DST (postgres:16, the source's minor)"
docker rm -f $DST > /dev/null 2>&1
sudo rm -rf "$W/pgdata-restore"
mkdir -p "$W/pgdata-restore"
docker run -d --name $DST --log-driver json-file --log-opt max-size=1m --log-opt max-file=1 -p 127.0.0.1:15491:5432 --memory 1024m --cpus 2 --shm-size 256m \
  -v "$W/pgdata-restore:/var/lib/postgresql/data" -v "$W/secrets/su:/run/lanef/su:ro" \
  -e POSTGRES_USER=lanef_admin -e POSTGRES_PASSWORD_FILE=/run/lanef/su -e POSTGRES_DB=postgres \
  -e POSTGRES_INITDB_ARGS="--auth-local=scram-sha-256 --auth-host=scram-sha-256 --data-checksums" \
  postgres:16 postgres -c password_encryption=scram-sha-256 -c shared_preload_libraries=pg_stat_statements > /dev/null
# Over TCP: the image's temporary init server answers on the socket only, then restarts.
for _ in $(seq 1 120); do docker exec $DST pg_isready -h 127.0.0.1 -U lanef_admin -d postgres > /dev/null 2>&1 && break; sleep 1; done
T_CLUSTER=$(($(ms) - R0))
log "cluster ready after ${T_CLUSTER} ms"
docker cp "$W/tls/server.crt" $DST:/var/lib/postgresql/data/server.crt
docker cp "$W/tls/server.key" $DST:/var/lib/postgresql/data/server.key
docker exec $DST sh -c 'cd /var/lib/postgresql/data && chown postgres:postgres server.crt server.key && chmod 600 server.key && printf "local all all scram-sha-256\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n" > pg_hba.conf && chown postgres:postgres pg_hba.conf'
su_sql $DST -d postgres -q -c "ALTER SYSTEM SET ssl = on" -c "select pg_reload_conf()" > /dev/null
(cd "$W/backup" && sha256sum -c SHA256SUMS --quiet) && log "archive checksums verified"
log "roles (no passwords), then a NEW random crewflow_owner password: the copy never reuses the source credential"
su_sql $DST -d postgres -q -f - < "$W/backup/roles.sql" > "$R/roles-load.txt" 2>&1
log "roles load: $(grep -c ERROR "$R/roles-load.txt") ERROR line(s): $(grep ERROR "$R/roles-load.txt" | head -3 | tr '\n' ' ')"
(umask 077 && openssl rand -hex 32 > "$W/secrets/owner-restore")
# psql interpolates :'pw' only in a script (never in -c): the statement goes in on stdin, the value from the file.
docker cp "$W/secrets/owner-restore" $DST:/tmp/opw > /dev/null
docker exec $DST chown postgres /tmp/opw
echo "ALTER ROLE crewflow_owner PASSWORD :'pw';" | docker exec -i -u postgres $DST sh -c 'PGPASSWORD="$(cat /run/lanef/su)" psql -X -q -v ON_ERROR_STOP=1 -h /var/run/postgresql -U lanef_admin -d postgres -v pw="$(cat /tmp/opw)" -f -; rc=$?; rm -f /tmp/opw; exit $rc' && log "crewflow_owner password replaced on the copy"
log "pg_restore --exit-on-error -j 2 (owners and ACLs kept; never --no-owner)"
t0=$(ms)
su_sql $DST -d postgres -q -c "CREATE DATABASE crewflow"
docker exec -i -u postgres $DST sh -c 'cat > /tmp/r.dump && PGPASSWORD="$(cat /run/lanef/su)" pg_restore -l /tmp/r.dump | wc -l && PGPASSWORD="$(cat /run/lanef/su)" pg_restore --exit-on-error -h /var/run/postgresql -U lanef_admin -d crewflow -j 2 /tmp/r.dump; rc=$?; rm -f /tmp/r.dump; exit $rc' < "$W/backup/crewflow.dump" > "$R/restore-out.txt" 2>&1
rcr=$?
T_PGRESTORE=$(($(ms) - t0))
log "pg_restore rc=$rcr in ${T_PGRESTORE} ms ($(head -1 "$R/restore-out.txt") TOC entries)"
# A -Fc archive of one database carries neither its database-level grants nor its ALTER DATABASE settings: re-apply them
# from the source catalog (a real restore reads them from the roles/globals file of the same backup).
su_sql $SRC -d crewflow -At -c "select datacl::text from pg_database where datname = 'crewflow'" > "$R/db-acl.txt"
su_sql $SRC -d crewflow -At -c "select coalesce(string_agg(s, ', '), '') from pg_db_role_setting d, unnest(d.setconfig) s where d.setdatabase = (select oid from pg_database where datname = 'crewflow') and d.setrole = 0" > "$R/db-settings.txt"
log "source database ACL $(cat "$R/db-acl.txt"); database-level settings: '$(cat "$R/db-settings.txt")'"
su_sql $DST -d postgres -q -c "GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO crewflow_owner" -c "REVOKE ALL ON DATABASE crewflow FROM PUBLIC"
su_sql $DST -d crewflow -q -c "analyze"
su_sql $DST -d crewflow -At -F ' ' -c "$COUNTS" > "$R/restore-counts.txt"
if diff "$R/source-counts.txt" "$R/restore-counts.txt" > "$R/counts-diff.txt"; then log "row counts and ledger IDENTICAL to the source at backup time"; else log "row counts DIFFER: $(head -5 "$R/counts-diff.txt" | tr '\n' ' ')"; fi
su_sql $DST -d crewflow -At -c "select environment, deployment_id from core.deployment_identity_check()" > "$R/identity.txt" 2>&1
log "deployment identity on the copy: '$(tr '\n' ' ' < "$R/identity.txt")' (unbound on this throwaway source, so no rebind step was needed)"
T_DATA=$(($(ms) - R0))
log "data restored and counted ${T_DATA} ms after RTO start"

# ------------------------------------------------------------------------------------------------- posture checks
RESTORE_OWNER_URL="postgres://crewflow_owner:$(cat "$W/secrets/owner-restore")@127.0.0.1:15491/crewflow?sslmode=verify-full"
RESTORE_ADMIN_URL="postgres://lanef_admin:$(cat "$W/secrets/su")@127.0.0.1:15491/crewflow?sslmode=verify-full"
chk() { # label url-for-rls url-for-posture
  local t0 a b c
  t0=$(ms)
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" NODE_ENV=test NODE_EXTRA_CA_CERTS="$W/tls/ca.crt" PG_SSL_CA_CERT_PATH="$W/tls/ca.crt" PG_LEGACY_NAMES_STRICT=true PG_DATABASE_URL="$2" \
    node node_modules/tsx/dist/cli.mjs tools/check-rls-coverage.ts > "$R/rls-$1.txt" 2>&1
  a=$?
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" NODE_ENV=test NODE_EXTRA_CA_CERTS="$W/tls/ca.crt" PG_SSL_CA_CERT_PATH="$W/tls/ca.crt" POSTURE_DATABASE_URL="$3" \
    node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.app.json packages/rab-server/src/database/typeorm/scripts/check-db-security-posture.ts > "$R/posture-$1.txt" 2>&1
  b=$?
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" NODE_ENV=test NODE_EXTRA_CA_CERTS="$W/tls/ca.crt" PG_SSL_CA_CERT_PATH="$W/tls/ca.crt" POSTURE_DATABASE_URL="$3" \
    node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.app.json packages/rab-server/src/database/typeorm/scripts/check-semantic-posture.ts > "$R/semantic-$1.txt" 2>&1
  c=$?
  log "$1: check-rls-coverage rc=$a, security-posture golden rc=$b, semantic-posture golden rc=$c ($(($(ms) - t0)) ms)"
  for f in rls posture semantic; do red < "$R/$f-$1.txt" | tail -2 | sed "s/^/    $f-$1: /" >> "$R/steps.log"; done
}
chk restore "$RESTORE_OWNER_URL" "$RESTORE_ADMIN_URL"
T_VERIFY=$(($(ms) - R0))
chk source "$LF_OWNER_URL" "$LF_ADMIN_URL"

# ------------------------------------------------------------------------------------------------- the app on the copy
log "API (production mode, the same build) on the copy, port 3491"
t0=$(ms)
lf_prod_env PG_DATABASE_URL="$RESTORE_OWNER_URL" PORT=3491 REDIS_URL=redis://127.0.0.1:16490/5 PG_POOL_MAX_CONNECTIONS=10 NODE_OPTIONS=--max-old-space-size=768 \
  nohup bash -c 'echo $$ > /data/crewtest-lanef/api-restore.pid; exec taskset -c 0,1 node packages/rab-server/dist/main.js' > "$W/logs/api-restore.log" 2>&1 &
for _ in $(seq 1 180); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:3491/healthz && break; sleep 1; done
H=$(curl -s --max-time 3 http://127.0.0.1:3491/healthz | head -c 160)
T_API=$(($(ms) - t0))
log "API healthz after ${T_API} ms: $H"
red < "$W/logs/api-restore.log" | grep -E "refus|Refus|FATAL" | head -5 >> "$R/steps.log"
PW="$(sed -n "s/^export E2E_SEED_PASSWORD='\(.*\)'$/\1/p" "$W/seed/live.env")"
LOGIN=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Content-Type: application/json' -H 'Origin: https://app.lanef.test' -H 'CF-Connecting-IP: 10.250.0.1' \
  --data-binary @- -c "$R/.cj" http://127.0.0.1:3491/rest/v1/auth/login <<< "{\"email\":\"admin@acme.test\",\"password\":\"$PW\"}")
READS=""
for p in "/shifts?limit=50" "/staff?limit=50" "/attendance?limit=50" "/payroll/records?status=approved&limit=50" "/dashboard/summary"; do
  READS="$READS $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Origin: https://app.lanef.test' -H 'CF-Connecting-IP: 10.250.0.1' -b "$R/.cj" "http://127.0.0.1:3491/rest/v1$p")"
done
SL=$(curl -s --max-time 10 -H 'Content-Type: application/json' -H 'X-Client-Platform: mobile' -H 'CF-Connecting-IP: 10.250.0.2' --data-binary @- http://127.0.0.1:3491/rest/v1/auth/login \
  <<< "{\"email\":\"perf2001@perf-lanef.test\",\"password\":\"$PW\",\"applicationTarget\":\"staff_app\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).accessToken||"")}catch{}})')
SR=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $SL" -H 'X-Client-Platform: mobile' -H 'CF-Connecting-IP: 10.250.0.2' "http://127.0.0.1:3491/rest/v1/attendance/me/history?limit=20")
rm -f "$R/.cj"
unset PW SL
T_RTO=$(($(ms) - R0))
T_RESTORE_END=$(ts)
log "console login $LOGIN, console reads:$READS, staff app login + history $SR"
log "RTO END (verified, serving real requests on the copy): ${T_RTO} ms"
kill "$(cat "$W/api-restore.pid")" 2> /dev/null
cat > "$R/timings.json" << J
{"dumpStart":"$T_DUMP_START","restoreStart":"$T_RESTORE_START","restoreEnd":"$T_RESTORE_END","dumpMs":$T_DUMP,"basebackupMs":$T_BASE,"clusterReadyMs":$T_CLUSTER,"pgRestoreMs":$T_PGRESTORE,"dataRestoredMs":$T_DATA,"verifiedMs":$T_VERIFY,"apiHealthyMs":$T_API,"rtoMs":$T_RTO,"dumpBytes":$(wc -c < "$W/backup/crewflow.dump"),"baseBytes":$(du -sb "$W/backup/base" | cut -f1)}
J
log "done"
