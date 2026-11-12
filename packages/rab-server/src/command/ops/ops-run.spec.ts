import { currentPgProcessRole, resolvePgEnvironment, RETIRED_OPS_ENV_NAMES, setPgProcessRole } from '../../database/postgres/pg-config';
import { assertHwsApplyAllowed } from './hws-cutover-policy';
import {
  assertOpsPlacement,
  assertOpsRun,
  describeOpsLabel,
  OPS_COMMANDS,
  OPS_LABEL_NOTE,
  opsAuditMetadata,
  OpsRunError,
  readOpsLabelFromFlags,
} from './ops-run';

// The ops commands (X2.2 owner-login path, the only path since rab-ops was removed): placement, the operator label and the
// one-login endpoint rule. Pure.
const APP = 'postgres://crewflow_app:pw-app-1@localhost:5432/rab';
// Every variable of the removed rab-ops container, with the value it used to carry.
const RETIRED_OPS_ENV: Record<(typeof RETIRED_OPS_ENV_NAMES)[number], string> = {
  CREWFLOW_OPS_RUN: 'one-off',
  PG_OPS_APP_DATABASE_URL: APP,
  CREWFLOW_OPS_ACTOR_SOURCE: 'github-actions',
  CREWFLOW_OPS_ACTOR_ID: 'repo:crewflow/rab:environment:production',
  CREWFLOW_OPS_CHANGE_REF: 'crewflow/rab#1234',
};
// The one login, and the label as flags.
const OWNER = 'postgres://crewflow_owner:pw-own-1@localhost:5432/rab';
const OWNER_ENV = { PG_DATABASE_URL: OWNER, DB_TARGET: 'local' };
const FLAGS = { operator: 'Jane O\'Neil (on-call)', changeRef: 'OPS-42' };

afterEach(() => setPgProcessRole('api'));

describe('ops placement (command/main.ts)', () => {
  it('X2.2: on the ordinary CLI path each ops command is refused under any login but crewflow_owner, before any connection', () => {
    for (const command of OPS_COMMANDS) {
      for (const user of ['crewflow_app', 'crewflow', 'crewflow_migrator', 'crewflow_worker', 'rab_secure_owner', 'postgres', 'crewflow_owner2']) {
        const url = `postgres://${user}:pw-x-1@localhost:5432/rab`;
        expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: url })).toThrow(new RegExp(`runs only under the owner login crewflow_owner; PG_DATABASE_URL names "${user}"`));
      }
      expect(() => assertOpsPlacement(command, {})).toThrow(/requires PG_DATABASE_URL naming the owner login crewflow_owner/);
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: 'not a url' })).toThrow(/refuses PG_DATABASE_URL: .*\(value not shown\)/);
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: 'mysql://crewflow_owner:pw@localhost/rab' })).toThrow(OpsRunError);
    }
  });

  it('X2.2: the login is read by the same parser as the connection (pg-url-policy parsePgUrl), so URL tricks cannot disagree with it', () => {
    for (const command of OPS_COMMANDS) {
      // A query-parameter user override is refused outright (it would change the login the pool sends).
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: `${OWNER}?user=postgres` })).toThrow(/refuses PG_DATABASE_URL: .*sets "user" as a query parameter/);
      // A session role in the startup options is refused for the CLI (it would make current_user differ from the login).
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: `${OWNER}?options=-c%20role%3Drab_secure_owner` })).toThrow(/refuses PG_DATABASE_URL: .*sets "options"/);
      // Percent-encoding decodes to the login the pool really sends: crewflow%5Fowner IS crewflow_owner.
      expect(assertOpsPlacement(command, { PG_DATABASE_URL: 'postgres://crewflow%5Fowner:pw-own-1@localhost:5432/rab' })).toBe('cli');
      // The parser trims the user and the pool connects with that trimmed user: accepted, and it is the login used.
      expect(assertOpsPlacement(command, { PG_DATABASE_URL: 'postgres://crewflow_owner%20:pw-own-1@localhost:5432/rab' })).toBe('cli');
      // A different user hidden by encoding is still that different user.
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: 'postgres://crewflow%5Fapp:pw-x-1@localhost:5432/rab' })).toThrow(/PG_DATABASE_URL names "crewflow_app"/);
    }
  });

  it('X2.2: refuses every libpq variable and the replica URL in every environment (not only production)', () => {
    for (const command of OPS_COMMANDS) {
      for (const name of ['PGOPTIONS', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGSERVICE', 'PGSSLMODE']) {
        expect(() => assertOpsPlacement(command, { ...OWNER_ENV, [name]: 'x' })).toThrow(new RegExp(`refuses libpq environment variable\\(s\\) ${name} in every environment`));
      }
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, PG_DATABASE_REPLICA_URL: 'postgres://crewflow_owner:pw@replica:5432/rab' })).toThrow(
        /refuses PG_DATABASE_REPLICA_URL: the ops commands have no replica path/,
      );
      // Empty means unset (the runbook's `-e PG_DATABASE_REPLICA_URL=` on the one-off run).
      expect(assertOpsPlacement(command, { ...OWNER_ENV, PG_DATABASE_REPLICA_URL: '' })).toBe('cli');
    }
  });

  it('X2.2: the owner-login path refuses a legacy database variable and every retired operations-container variable', () => {
    for (const command of OPS_COMMANDS) {
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, DATABASE_URL_UNPOOLED: 'postgres://postgres:pw@localhost/rab' })).toThrow(
        /remove the legacy database variable\(s\) DATABASE_URL_UNPOOLED/,
      );
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, DATABASE_URL: OWNER })).toThrow(/legacy database variable\(s\) DATABASE_URL/);
      for (const name of RETIRED_OPS_ENV_NAMES) {
        expect(() => assertOpsPlacement(command, { ...OWNER_ENV, [name]: RETIRED_OPS_ENV[name] })).toThrow(
          new RegExp(`"${command}" refuses the retired operations-container variable\\(s\\) ${name}: the rab-ops container was removed`),
        );
      }
    }
  });

  it('X2.2: under crewflow_owner each ops command is placed on the ordinary CLI path (`cli`)', () => {
    for (const command of OPS_COMMANDS) expect(assertOpsPlacement(command, OWNER_ENV)).toBe('cli');
    expect(assertOpsPlacement('user-session:backfill', { PG_DATABASE_URL: 'postgresql://crewflow_owner:pw@db.internal:5432/crewflow?sslmode=verify-full' })).toBe('cli');
  });

  it('rab-ops removed: the old ops-container invocation (CREWFLOW_OPS_RUN=one-off and the rest) is refused for every command, not run as "ops"', () => {
    for (const command of [...OPS_COMMANDS, 'seed', 'bootstrap-admin', undefined]) {
      // The exact old rab-ops environment, with and without the owner login next to it.
      expect(() => assertOpsPlacement(command, RETIRED_OPS_ENV)).toThrow(OpsRunError);
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, ...RETIRED_OPS_ENV })).toThrow(/refuses the retired operations-container variable\(s\) CREWFLOW_OPS_RUN, PG_OPS_APP_DATABASE_URL/);
      // CREWFLOW_OPS_RUN alone, with its old value or any other.
      for (const value of ['one-off', 'true', 'x']) {
        expect(() => assertOpsPlacement(command, { ...OWNER_ENV, CREWFLOW_OPS_RUN: value })).toThrow(/refuses the retired operations-container variable\(s\) CREWFLOW_OPS_RUN/);
      }
    }
    // The refusal names the replacement, and never declares a process role.
    expect(() => assertOpsPlacement('hws:backfill', { ...OWNER_ENV, CREWFLOW_OPS_RUN: 'one-off' })).toThrow(/one-off CLI commands under the owner login crewflow_owner.*--operator, --change-ref, --operator-source/);
    setPgProcessRole('api');
    expect(() => assertOpsPlacement('hws:backfill', { ...OWNER_ENV, CREWFLOW_OPS_RUN: 'one-off' })).toThrow(OpsRunError);
    expect(currentPgProcessRole()).toBe('api');
  });

  it('an ordinary CLI command refuses every retired ops variable; without them it is `cli`', () => {
    for (const name of RETIRED_OPS_ENV_NAMES) {
      expect(() => assertOpsPlacement('seed', { [name]: RETIRED_OPS_ENV[name] })).toThrow(
        new RegExp(`the CLI command "seed" refuses the retired operations-container variable\\(s\\) ${name}`),
      );
    }
    // Empty means unset.
    expect(assertOpsPlacement('seed', { CREWFLOW_OPS_RUN: '', PG_OPS_APP_DATABASE_URL: '  ' })).toBe('cli');
    expect(assertOpsPlacement('seed', {})).toBe('cli');
    expect(currentPgProcessRole()).toBe('cli');
  });
});

describe('the operator label (operational, not database-verified)', () => {
  it('is recorded verbatim with its fixed note, a run id, and the verified database facts kept apart', () => {
    const label = readOpsLabelFromFlags({ ...FLAGS, operatorSource: 'github-actions' }, 'user-session:backfill', 'apply');
    expect(label.runId).toMatch(/^[0-9a-f-]{36}$/);
    const metadata = opsAuditMetadata(label, { appLogin: 'crewflow_owner', elevatedLogin: 'crewflow_owner', elevatedRole: 'rab_secure_owner', identity: 'unbound' });
    expect(metadata.operationalLabel).toEqual(label);
    expect(metadata.databaseVerified).toMatchObject({ appLogin: 'crewflow_owner', elevatedLogin: 'crewflow_owner', elevatedRole: 'rab_secure_owner' });
  });
});

describe('X2.2: the operator label as flags (owner-login path; owner decision G1 option c)', () => {
  it('--operator and --change-ref are required: each missing one is named, for every ops command', () => {
    for (const command of OPS_COMMANDS) {
      for (const [key, flag] of [['operator', '--operator'], ['changeRef', '--change-ref']] as const) {
        expect(() => readOpsLabelFromFlags({ ...FLAGS, [key]: undefined }, command, 'dry-run')).toThrow(new RegExp(`missing: ${flag}\\)`));
        expect(() => readOpsLabelFromFlags({ ...FLAGS, [key]: '   ' }, command, 'dry-run')).toThrow(new RegExp(`missing: ${flag}\\)`));
      }
      expect(() => readOpsLabelFromFlags({}, command, 'dry-run')).toThrow(/requires the operator label --operator, --change-ref \(missing: --operator, --change-ref\)/);
    }
  });

  it('--operator-source is optional (default manual-console) but validated when given', () => {
    expect(readOpsLabelFromFlags(FLAGS, 'hws:backfill', 'dry-run').actorSource).toBe('manual-console');
    expect(readOpsLabelFromFlags({ ...FLAGS, operatorSource: 'github-actions' }, 'hws:backfill', 'dry-run').actorSource).toBe('github-actions');
    expect(() => readOpsLabelFromFlags({ ...FLAGS, operatorSource: 'laptop' }, 'hws:backfill', 'dry-run')).toThrow(/--operator-source must be one of github-actions, gitlab-ci, manual-console/);
    expect(() => readOpsLabelFromFlags({ ...FLAGS, operatorSource: '' }, 'hws:backfill', 'dry-run')).toThrow(/--operator-source must be one of/);
  });

  it('--operator accepts a name with spaces (and non-ASCII letters), trimmed', () => {
    expect(readOpsLabelFromFlags({ ...FLAGS, operator: '  Jane Smith  ' }, 'hws:backfill', 'dry-run').actorId).toBe('Jane Smith');
    expect(readOpsLabelFromFlags({ ...FLAGS, operator: 'José Ñúñez' }, 'hws:backfill', 'dry-run').actorId).toBe('José Ñúñez');
    expect(readOpsLabelFromFlags({ ...FLAGS, operator: 'repo:org/repo:environment:production' }, 'hws:backfill', 'dry-run').actorId).toBe(
      'repo:org/repo:environment:production',
    );
    expect(readOpsLabelFromFlags({ ...FLAGS, operator: 'a'.repeat(200) }, 'hws:backfill', 'dry-run').actorId).toHaveLength(200);
  });

  it.each<[string, string]>([
    ['a newline', 'Jane\nSmith'],
    ['a carriage return', 'Jane\rSmith'],
    ['a tab', 'Jane\tSmith'],
    ['a NUL', 'Jane\u0000Smith'],
    ['an escape sequence', 'Jane\u001b[31mSmith'],
    ['a DEL', 'Jane\u007fSmith'],
    ['a C1 control', 'Jane\u0085Smith'],
    ['a bidi override', 'Jane\u202eSmith'],
    ['a zero-width joiner', 'Jane\u200dSmith'],
    ['a line separator', 'Jane\u2028Smith'],
    ['a double quote', 'Jane "x" Smith'],
    ['a semicolon (SQL-looking)', "x'; DROP TABLE core.audit_log; --"],
    ['a leading punctuation', '-rf'],
    ['201 characters', 'a'.repeat(201)],
  ])('--operator refuses %s', (_name, value) => {
    expect(() => readOpsLabelFromFlags({ ...FLAGS, operator: value }, 'hws:backfill', 'dry-run')).toThrow(/--operator must be 1-200 characters/);
  });

  it('--change-ref keeps the strict reference rule', () => {
    expect(() => readOpsLabelFromFlags({ ...FLAGS, changeRef: '-rf' }, 'hws:backfill', 'dry-run')).toThrow(/--change-ref must be/);
    expect(() => readOpsLabelFromFlags({ ...FLAGS, changeRef: 'OPS 1' }, 'hws:backfill', 'dry-run')).toThrow(/--change-ref must be/);
  });

  it('records the owner-login path and the operator name, marked as a claim, not a verified identity', () => {
    expect(readOpsLabelFromFlags(FLAGS, 'containment:suspend-test-accounts', 'execute')).toMatchObject({
      kind: 'operational-label',
      note: OPS_LABEL_NOTE,
      actorSource: 'manual-console',
      actorId: "Jane O'Neil (on-call)",
      changeRef: 'OPS-42',
      command: 'containment:suspend-test-accounts',
      mode: 'execute',
      path: 'owner-login',
    });
    expect(OPS_LABEL_NOTE).toBe('operational label, not database-verified identity');
  });

  it('the console line JSON-quotes the operator name', () => {
    expect(describeOpsLabel(readOpsLabelFromFlags(FLAGS, 'hws:backfill', 'dry-run'))).toContain(`operator="Jane O'Neil (on-call)"`);
  });
});

describe('assertOpsRun (layer 2, every ops command body)', () => {
  it('X2.2: on the CLI path, refuses any login but crewflow_owner even when called directly (every ops command)', () => {
    setPgProcessRole('cli');
    for (const command of OPS_COMMANDS) {
      const env = { PG_DATABASE_URL: APP };
      expect(() => assertOpsRun(command, 'dry-run', resolvePgEnvironment(env, { processRole: 'cli' }), env, FLAGS)).toThrow(
        /runs only under the owner login crewflow_owner/,
      );
    }
  });

  it('X2.2: refuses a missing label on the owner-login path (every ops command)', () => {
    setPgProcessRole('cli');
    const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: 'cli' });
    for (const command of OPS_COMMANDS) {
      expect(() => assertOpsRun(command, 'dry-run', resolved, OWNER_ENV)).toThrow(/requires the operator label --operator, --change-ref/);
      expect(() => assertOpsRun(command, 'apply', resolved, OWNER_ENV, { ...FLAGS, changeRef: undefined })).toThrow(/missing: --change-ref/);
    }
  });

  it('X2.2: refuses inside the API, the Worker or the provisioner (a command body reached without main.ts)', () => {
    for (const role of ['api', 'worker', 'provisioner'] as const) {
      setPgProcessRole(role);
      const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: role });
      for (const command of OPS_COMMANDS) {
        expect(() => assertOpsRun(command, 'dry-run', resolved, OWNER_ENV, FLAGS)).toThrow(new RegExp(`never inside the ${role} process`));
      }
    }
  });

  it('X2.2: refuses the legacy second-endpoint variable DATABASE_URL_UNPOOLED in layer 2 (the environment rule)', () => {
    setPgProcessRole('cli');
    const withUnpooled = { ...OWNER_ENV, DATABASE_URL_UNPOOLED: 'postgres://postgres:pw-su-1@localhost:5432/rab' };
    expect(() => assertOpsRun('user-session:backfill', 'apply', resolvePgEnvironment(withUnpooled, { processRole: 'cli' }), withUnpooled, FLAGS)).toThrow(
      /remove the legacy database variable\(s\) DATABASE_URL_UNPOOLED/,
    );
  });

  it('X2.2: refuses a resolved second endpoint even when the environment handed to layer 2 does not show it (defence in depth)', () => {
    setPgProcessRole('cli');
    const withUnpooled = { ...OWNER_ENV, DATABASE_URL_UNPOOLED: 'postgres://postgres:pw-su-1@localhost:5432/rab' };
    const resolved = resolvePgEnvironment(withUnpooled, { processRole: 'cli' });
    expect(resolved.elevated).not.toBeNull();
    expect(() => assertOpsRun('user-session:backfill', 'apply', resolved, OWNER_ENV, FLAGS)).toThrow(
      /uses the one login only; a second database endpoint \(DATABASE_URL_UNPOOLED\) is refused/,
    );
  });

  it('X2.2: accepts crewflow_owner with the label (every mode; no mode asks for a second credential)', () => {
    setPgProcessRole('cli');
    const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: 'cli' });
    expect(assertOpsRun('containment:suspend-test-accounts', 'execute', resolved, OWNER_ENV, FLAGS)).toMatchObject({ path: 'owner-login', mode: 'execute' });
    expect(assertOpsRun('user-session:backfill', 'verify', resolved, OWNER_ENV, FLAGS).path).toBe('owner-login');
    expect(assertOpsRun('hws:backfill', 'apply', resolved, OWNER_ENV, FLAGS).command).toBe('hws:backfill');
  });

  it('rab-ops removed: a retired ops variable in the environment handed to layer 2 is refused (a command body reached without main.ts)', () => {
    setPgProcessRole('cli');
    const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: 'cli' });
    for (const command of OPS_COMMANDS) {
      for (const name of RETIRED_OPS_ENV_NAMES) {
        expect(() => assertOpsRun(command, 'dry-run', resolved, { ...OWNER_ENV, [name]: RETIRED_OPS_ENV[name] }, FLAGS)).toThrow(
          new RegExp(`refuses the retired operations-container variable\\(s\\) ${name}`),
        );
      }
    }
  });

  it('rab-ops removed: the old ops-container label variables are no substitute for the flags', () => {
    setPgProcessRole('cli');
    const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: 'cli' });
    const env = { ...OWNER_ENV, CREWFLOW_OPS_ACTOR_SOURCE: 'github-actions', CREWFLOW_OPS_ACTOR_ID: 'me', CREWFLOW_OPS_CHANGE_REF: 'OPS-1' };
    expect(() => assertOpsRun('hws:backfill', 'dry-run', resolved, env)).toThrow(/retired operations-container variable\(s\) CREWFLOW_OPS_ACTOR_SOURCE, CREWFLOW_OPS_ACTOR_ID, CREWFLOW_OPS_CHANGE_REF/);
  });
});

describe('hws:backfill --apply while HWS is off', () => {
  it('refuses without --hws-cutover (production wording in production), accepts with it; the flag is apply-only', () => {
    expect(() => assertHwsApplyAllowed({ mode: 'apply', hwsRuntimeEnabled: false, hwsCutover: false, production: true })).toThrow(
      /HWS runtime routing is OFF \(HWS_RUNTIME_ENABLED=false\) in PRODUCTION.*do NOT run it in production while HWS is off/,
    );
    expect(() => assertHwsApplyAllowed({ mode: 'apply', hwsRuntimeEnabled: false, hwsCutover: false, production: false })).toThrow(/--hws-cutover/);
    expect(() => assertHwsApplyAllowed({ mode: 'apply', hwsRuntimeEnabled: false, hwsCutover: true, production: true })).not.toThrow();
    expect(() => assertHwsApplyAllowed({ mode: 'apply', hwsRuntimeEnabled: true, hwsCutover: false, production: true })).not.toThrow();
    expect(() => assertHwsApplyAllowed({ mode: 'dry-run', hwsRuntimeEnabled: false, hwsCutover: false, production: true })).not.toThrow();
    expect(() => assertHwsApplyAllowed({ mode: 'verify', hwsRuntimeEnabled: false, hwsCutover: true, production: false })).toThrow(/applies only to --apply/);
  });
});
