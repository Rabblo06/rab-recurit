// Opt-in evidence collector (RAB_ASSERTION_PROBE_FILE=<path>): after every
// test, appends how many `expect` assertions actually ran plus the shared
// identity factory's cumulative login counters (test-identities.ts). Used to
// PROVE a security suite reached its assertions instead of dying in
// setup/login. Inert unless the env var is set.
import { appendFileSync } from 'node:fs';

const file = process.env.RAB_ASSERTION_PROBE_FILE;
if (file) {
  afterEach(() => {
    const state = expect.getState();
    const probe = (globalThis as unknown as { __RAB_TEST_PROBE__?: { logins: number; loginFailures: number } }).__RAB_TEST_PROBE__ ?? {
      logins: 0,
      loginFailures: 0,
    };
    appendFileSync(
      file,
      JSON.stringify({
        suite: (state.testPath ?? '').split(/[\\/]/).pop(),
        test: state.currentTestName,
        assertions: state.assertionCalls,
        logins: probe.logins,
        loginFailures: probe.loginFailures,
      }) + '\n',
    );
  });
}
