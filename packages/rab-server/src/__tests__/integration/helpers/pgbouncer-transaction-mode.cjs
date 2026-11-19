'use strict';
/**
 * Writes the configuration of a PgBouncer in pool_mode=transaction in front of the disposable test database, for
 * transaction-pooler.integration.spec.ts (CI job ci-server / test-transaction-pooler). Test tooling only.
 *
 *   TEST_DATABASE_URL=<crewflow_owner URL> node pgbouncer-transaction-mode.cjs <dir> <listen-port> <pool-size>
 *
 * Writes <dir>/pgbouncer.ini and <dir>/userlist.txt (mode 0600; the crewflow_owner password, which PgBouncer needs for SCRAM
 * to the server). Prints nothing but the two file names: never a password or a URL.
 */
const fs = require('node:fs');
const path = require('node:path');

const [dir, port, poolSize] = process.argv.slice(2);
if (!dir || !/^\d{2,5}$/.test(port ?? '') || !/^\d{1,2}$/.test(poolSize ?? '')) {
  console.error('usage: node pgbouncer-transaction-mode.cjs <dir> <listen-port> <pool-size>');
  process.exit(2);
}
const raw = process.env.TEST_DATABASE_URL;
if (!raw) {
  console.error('TEST_DATABASE_URL is required');
  process.exit(2);
}
const url = new URL(raw);
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
if (user !== 'crewflow_owner' || password === '') {
  console.error('TEST_DATABASE_URL must be the crewflow_owner URL with a password');
  process.exit(2);
}
const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
fs.mkdirSync(dir, { recursive: true });
const ini = [
  '[databases]',
  `* = host=${host} port=${url.port || '5432'}`,
  '[pgbouncer]',
  'listen_addr = 127.0.0.1',
  `listen_port = ${port}`,
  'unix_socket_dir =',
  'auth_type = scram-sha-256',
  `auth_file = ${path.join(dir, 'userlist.txt')}`,
  'pool_mode = transaction',
  `default_pool_size = ${poolSize}`,
  'min_pool_size = 0',
  'reserve_pool_size = 0',
  'max_client_conn = 200',
  'server_tls_sslmode = prefer',
  'client_tls_sslmode = disable',
  'ignore_startup_parameters = extra_float_digits',
  // Transaction mode never runs server_reset_query; left empty so nothing hides a poisoned backend from the test.
  'server_reset_query =',
  'server_round_robin = 0',
  `logfile = ${path.join(dir, 'pgbouncer.log')}`,
  `pidfile = ${path.join(dir, 'pgbouncer.pid')}`,
  '',
].join('\n');
fs.writeFileSync(path.join(dir, 'pgbouncer.ini'), ini, { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'userlist.txt'), `"${user}" "${password.replace(/"/g, '""')}"\n`, { mode: 0o600 });
console.log(`wrote ${path.join(dir, 'pgbouncer.ini')} and ${path.join(dir, 'userlist.txt')}`);
