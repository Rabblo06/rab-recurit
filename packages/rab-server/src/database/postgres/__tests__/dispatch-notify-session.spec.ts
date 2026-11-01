import { PgProcessRole, resolvePgEnvironment, resolvePgEnvironmentCached } from '../pg-config';
import { pgClientConfig, pgTypeOrmConnectionOptions } from '../create-pg-pool';
import { PgConfigError } from '../pg-url-policy';

/**
 * Phase D, SQL review E-1: the pointer triggers call pg_notify only when the WRITING session has
 * `crewflow.dispatch_notify = 'on'`. The connection factory sets it as a startup option (`-c`, so every new pooled or
 * direct connection — including reconnects — carries it; nothing a request sends can choose it) for the API and the
 * Worker's runtime/lock connections, and ONLY when WORKER_DISPATCH_MODE=event. Default poll ⇒ the setting is absent ⇒
 * zero NOTIFY. The real-database check is dispatch-notify-session.integration.spec.ts.
 */
const URL = 'postgres://crewflow_app:pw@localhost:5432/rab';
const ON = '-c crewflow.dispatch_notify=on';

function options(processRole: PgProcessRole, mode: string | undefined, request: Partial<Parameters<typeof pgClientConfig>[1]> = {}): string {
  const env = { NODE_ENV: 'test', PG_DATABASE_URL: URL, ...(mode === undefined ? {} : { WORKER_DISPATCH_MODE: mode }) };
  const resolved = resolvePgEnvironment(env, { processRole, enforceProcessPolicy: false });
  return String(pgClientConfig(resolved, { purpose: 'runtime', ...request }).options);
}

describe('crewflow.dispatch_notify session setting (E-1)', () => {
  it.each(['api', 'worker'] as const)('%s: on only in event mode (runtime and lock endpoints)', (role) => {
    expect(options(role, 'event')).toContain(ON);
    expect(options(role, 'event', { endpoint: 'lock', purpose: 'lock' })).toContain(ON);
    for (const mode of [undefined, '', 'poll']) expect(options(role, mode)).not.toContain('crewflow.dispatch_notify');
  });

  it.each(['provisioner', 'cli', 'migrate'] as const)('%s never sets it, whatever the mode', (role) => {
    expect(options(role, 'event')).not.toContain('crewflow.dispatch_notify');
  });

  it('read-only and replica sessions never set it (they write nothing)', () => {
    expect(options('api', 'event', { readOnly: true })).not.toContain('crewflow.dispatch_notify');
  });

  it('the TypeORM pool (what the API and Worker DataSources use) carries it', () => {
    const resolved = resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: URL, WORKER_DISPATCH_MODE: 'event' }, { processRole: 'api', enforceProcessPolicy: false });
    expect(String((pgTypeOrmConnectionOptions(resolved, { purpose: 'runtime' }).extra as { options?: string }).options)).toContain(ON);
  });

  it('a malformed WORKER_DISPATCH_MODE refuses (fail closed) for the API and Worker', () => {
    for (const bad of ['Event', 'on', 'true']) {
      expect(() => resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: URL, WORKER_DISPATCH_MODE: bad }, { processRole: 'api', enforceProcessPolicy: false })).toThrow(
        PgConfigError,
      );
    }
  });

  it('the cached resolution keys on WORKER_DISPATCH_MODE (a changed mode is never served a stale setting)', () => {
    const poll = resolvePgEnvironmentCached({ NODE_ENV: 'test', PG_DATABASE_URL: URL }, { processRole: 'worker', enforceProcessPolicy: false });
    const event = resolvePgEnvironmentCached({ NODE_ENV: 'test', PG_DATABASE_URL: URL, WORKER_DISPATCH_MODE: 'event' }, { processRole: 'worker', enforceProcessPolicy: false });
    expect(poll.dispatchNotify).toBe(false);
    expect(event.dispatchNotify).toBe(true);
  });
});
