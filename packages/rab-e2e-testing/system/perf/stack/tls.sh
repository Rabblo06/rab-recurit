#!/usr/bin/env bash
# A test CA and a server certificate for 127.0.0.1 in the disposable cluster, so every process connects with sslmode=verify-full as in production.
set -euo pipefail
W=/data/crewtest-lanef; T=$W/tls; mkdir -p $T; cd $T
umask 077
openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -keyout ca.key -out ca.crt -days 30 -subj '/CN=crewtest lanef CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -keyout server.key -out server.csr -subj '/CN=127.0.0.1' 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 29 -extfile server.ext 2>/dev/null
rm -f ca.key ca.srl server.csr server.ext; chmod 644 ca.crt server.crt
docker cp server.crt crewtest-lanef-pg:/var/lib/postgresql/data/server.crt
docker cp server.key crewtest-lanef-pg:/var/lib/postgresql/data/server.key
docker exec crewtest-lanef-pg sh -c 'cd /var/lib/postgresql/data && chown postgres:postgres server.crt server.key && chmod 600 server.key && printf "local all all scram-sha-256\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n" > pg_hba.conf && chown postgres:postgres pg_hba.conf'
docker exec -u postgres crewtest-lanef-pg sh -c 'PGPASSWORD="$(cat /run/lanef/su)" psql -X -q -h /var/run/postgresql -U lanef_admin -d crewflow -c "ALTER SYSTEM SET ssl = on" -c "ALTER SYSTEM SET ssl_min_protocol_version = '"'"'TLSv1.2'"'"'" -c "select pg_reload_conf()"' >/dev/null
sleep 1
docker exec -u postgres crewtest-lanef-pg sh -c 'PGPASSWORD="$(cat /run/lanef/su)" psql -X -At -h /var/run/postgresql -U lanef_admin -d crewflow -c "show ssl"'
echo TLS_OK
