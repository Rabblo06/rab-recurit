'use strict';
/**
 * db-setup's wait for the database (owner instruction 2026-11-18): Twenty's Helm wait-for-db init container, re-implemented
 * (twentyhq/twenty@eedb0a73 helm/twenty: the init containers exist only `if .Values.db.enabled`, and nothing depends on a
 * database that may not exist). In docker-compose.production.yml and docker-compose.image.yml db-setup has NO depends_on: with
 * CREWFLOW_BUNDLED_DB=0 the bundled db has no container, and OpenShip then skipped db-setup ('Dependency "db" has no
 * container for service_healthy'). db-setup waits for the database itself instead, with the block between
 * `# BEGIN crewflow wait-for-db` and `# END crewflow wait-for-db` in rab/db-setup.sh. The pinned release's db-setup.sh does not
 * have that block yet, so those two files start db-setup through a wrapper that runs the SAME block and then execs
 * ./db-setup.sh unchanged:
 *   entrypoint: ["/bin/sh", "-c", "set -eu\n<the block>crewflow_wait_for_db\nexec ./db-setup.sh\n", "db-setup"]
 * Pure helpers for the gates (compose-owner-login.cjs, compose-credential-isolation.cjs, verify-image-compose.cjs) and
 * the shell tests (run-prestart-shell-tests.cjs). Never reads or prints a value of any environment.
 */
const fs = require('node:fs');
const path = require('node:path');

const DB_SETUP_SH = path.resolve(__dirname, '..', 'rab', 'db-setup.sh');
const WAIT_BLOCK = /# BEGIN crewflow wait-for-db\n[\s\S]*?# END crewflow wait-for-db\n/;
const WAIT_SECONDS_KEY = 'CREWFLOW_DB_WAIT_SECONDS';
const WAIT_SECONDS_EXPR = '${CREWFLOW_DB_WAIT_SECONDS:-300}';
const WAIT_SECONDS_DEFAULT = '300';
const WAIT_SECONDS_MAX = 900;

/** The wait block of a shell text (BEGIN line through END line), or null. */
function waitBlock(text) {
  const m = WAIT_BLOCK.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/** The committed block, from rab/db-setup.sh. Throws when it is missing (the gates fail closed). */
function committedWaitBlock() {
  const block = waitBlock(fs.readFileSync(DB_SETUP_SH, 'utf8'));
  if (!block) throw new Error('rab/db-setup.sh has no "# BEGIN crewflow wait-for-db" block');
  return block;
}

/** The exact `sh -c` script of the compose wrapper (after Compose's `$$` escape is undone). */
function waitWrapperScript() {
  return `set -eu\n${committedWaitBlock()}crewflow_wait_for_db\nexec ./db-setup.sh\n`;
}

/** Compose writes a literal `$` as `$$` (in the file and in `docker compose config`); the block has no `$$` of its own. */
const unescapeCompose = (s) => String(s ?? '').split('$$').join('$');

/**
 * Which start a db-setup entrypoint is: 'plain' = exactly ["./db-setup.sh"] (dev and QA, which keep depends_on: db and
 * build the image from source, wait included); 'wait' = exactly the wrapper above; null = anything else.
 */
function dbSetupEntrypointForm(entrypoint) {
  if (!Array.isArray(entrypoint)) return null;
  if (entrypoint.length === 1 && entrypoint[0] === './db-setup.sh') return 'plain';
  if (entrypoint.length === 4 && entrypoint[0] === '/bin/sh' && entrypoint[1] === '-c' && entrypoint[3] === 'db-setup'
    && unescapeCompose(entrypoint[2]) === waitWrapperScript()) return 'wait';
  return null;
}

/**
 * db-setup's start and dependencies in one rendered (or parsed) model. Pure; returns problem texts (service and key names
 * only). `requireWait`: the file must use the wrapper (production and image: no dependency on a db that may not exist).
 *   - 'wait': no depends_on at all, and CREWFLOW_DB_WAIT_SECONDS committed exactly as ${CREWFLOW_DB_WAIT_SECONDS:-300}
 *     (rendered: `renderedWait`, the value expected after interpolation; undefined = the raw expression; null = any value
 *     db-setup.sh accepts, for a deployed model rendered with the operator's compose.env);
 *   - 'plain': depends_on exactly a healthy db (the file's own ordering; allowed only without requireWait);
 *   - rab-api never depends on db when db-setup waits itself (the same 0-replica skip would stop the API).
 */
function dbSetupStartProblems(services, { requireWait = false, renderedWait, where = '' } = {}) {
  const out = [];
  const setup = services?.['db-setup'];
  if (!setup) return out;
  const form = dbSetupEntrypointForm(setup.entrypoint);
  const deps = setup.depends_on ?? {};
  const depNames = Array.isArray(deps) ? deps : Object.keys(deps);
  if (form === null) out.push(`db-setup: entrypoint is neither exactly ./db-setup.sh nor exactly the wait-for-db wrapper (the block of rab/db-setup.sh, then exec ./db-setup.sh)${where}`);
  if (requireWait && form !== 'wait') out.push(`db-setup: must start through the wait-for-db wrapper${where} (no depends_on: db; with CREWFLOW_BUNDLED_DB=0 there is no db container)`);
  if (form === 'wait') {
    if (depNames.length) out.push(`db-setup: has depends_on (${depNames.join(', ')})${where}; it waits for the database itself (a dependency on db that may have no container stops it on OpenShip)`);
    const env = setup.environment ?? {};
    const want = renderedWait === undefined ? WAIT_SECONDS_EXPR : renderedWait;
    if (!(WAIT_SECONDS_KEY in env)) out.push(`db-setup: ${WAIT_SECONDS_KEY} is missing${where} (committed: ${WAIT_SECONDS_EXPR})`);
    else if (want === null ? waitSecondsProblem(env[WAIT_SECONDS_KEY]) !== null : String(env[WAIT_SECONDS_KEY]) !== String(want)) {
      out.push(`db-setup: ${WAIT_SECONDS_KEY} is not the committed ${WAIT_SECONDS_EXPR}${want === null ? ' (0-900 whole seconds)' : ''}${where}`);
    }
    const apiDeps = services['rab-api']?.depends_on ?? {};
    if ((Array.isArray(apiDeps) ? apiDeps : Object.keys(apiDeps)).includes('db')) out.push(`rab-api: depends on db${where} (db-setup waits for the database; with CREWFLOW_BUNDLED_DB=0 there is no db container)`);
  }
  if (form === 'plain' && (depNames.length !== 1 || depNames[0] !== 'db' || deps.db?.condition !== 'service_healthy')) {
    out.push(`db-setup: depends_on must be exactly a healthy db when it starts ./db-setup.sh directly${where}`);
  }
  return out;
}

/** compose.env's CREWFLOW_DB_WAIT_SECONDS: empty (= 300) or a whole number 0-900, as db-setup.sh accepts it. */
function waitSecondsProblem(value) {
  const v = String(value ?? '');
  if (v === '') return null;
  if (!/^[0-9]{1,3}$/.test(v) || Number(v) > WAIT_SECONDS_MAX) return `${WAIT_SECONDS_KEY}: must be a whole number of seconds from 0 to ${WAIT_SECONDS_MAX} (unset = ${WAIT_SECONDS_DEFAULT}; 0 = do not wait)`;
  return null;
}

module.exports = {
  DB_SETUP_SH,
  WAIT_SECONDS_KEY,
  WAIT_SECONDS_EXPR,
  WAIT_SECONDS_DEFAULT,
  waitBlock,
  committedWaitBlock,
  waitWrapperScript,
  unescapeCompose,
  dbSetupEntrypointForm,
  dbSetupStartProblems,
  waitSecondsProblem,
};
