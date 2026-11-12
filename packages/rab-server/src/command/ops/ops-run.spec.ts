import { resolvePgEnvironment, setPgProcessRole } from '../../database/postgres/pg-config';
import { assertHwsApplyAllowed } from './hws-cutover-policy';
import {
  assertOpsPlacement,
  assertOpsRun,
  assertOpsValuesNotFromDotenv,
  OPS_COMMANDS,
  OPS_LABEL_NOTE,
  opsAuditMetadata,
  OpsRunError,
  readOpsLabelFromFlags,
  readOpsOperationalLabel,
} from './ops-run';

// Phase B ops container: placement, the operator label, the .env rule and the minimum-privilege endpoint rule. Pure.
const APP = 'postgres://crewflow_app:pw-app-1@localhost:5432/rab';
const MIGRATOR = 'postgres://crewflow_migrator:pw-mig-1@localhost:5432/rab';
const LABEL = {
  CREWFLOW_OPS_ACTOR_SOURCE: 'github-actions',
  CREWFLOW_OPS_ACTOR_ID: 'repo:crewflow/rab:environment:production',
  CREWFLOW_OPS_CHANGE_REF: 'crewflow/rab#1234',
};
const OPS_ENV = { CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: APP, ...LABEL };
// X2.2 owner-login path: the one login, and the label as flags.
const OWNER = 'postgres://crewflow_owner:pw-own-1@localhost:5432/rab';
const OWNER_ENV = { PG_DATABASE_URL: OWNER, DB_TARGET: 'local' };
const FLAGS = { operatorSource: 'manual-console', operatorId: 'deploy-user@host-1', changeRef: 'OPS-42' };

afterEach(() => setPgProcessRole('api'));

describe('ops placement (command/main.ts)', () => {
  it('X2.2: on the ordinary CLI path each ops command is refused under any login but crewflow_owner, before any connection', () => {
    for (const command of OPS_COMMANDS) {
      for (const user of ['crewflow_app', 'crewflow', 'crewflow_migrator', 'crewflow_worker', 'rab_secure_owner', 'postgres', 'crewflow_owner2']) {
        const url = `postgres://${user}:pw-x-1@localhost:5432/rab`;
        expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: url })).toThrow(new RegExp(`runs only under the owner login crewflow_owner; PG_DATABASE_URL names "${user}"`));
      }
      expect(() => assertOpsPlacement(command, {})).toThrow(/requires PG_DATABASE_URL naming the owner login crewflow_owner/);
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: 'not a url' })).toThrow(/an unparsable URL \(value not shown\)/);
      expect(() => assertOpsPlacement(command, { PG_DATABASE_URL: 'mysql://crewflow_owner:pw@localhost/rab' })).toThrow(OpsRunError);
    }
  });

  it('X2.2: the owner-login path refuses a legacy database variable and every operations-container variable', () => {
    for (const command of OPS_COMMANDS) {
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, DATABASE_URL_UNPOOLED: 'postgres://postgres:pw@localhost/rab' })).toThrow(
        /remove the legacy database variable\(s\) DATABASE_URL_UNPOOLED/,
      );
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, DATABASE_URL: OWNER })).toThrow(/legacy database variable\(s\) DATABASE_URL/);
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, CREWFLOW_OPS_ACTOR_ID: 'x' })).toThrow(/refuses the operations-container variable\(s\) CREWFLOW_OPS_ACTOR_ID/);
      expect(() => assertOpsPlacement(command, { ...OWNER_ENV, PG_OPS_APP_DATABASE_URL: APP })).toThrow(/PG_OPS_APP_DATABASE_URL/);
    }
  });

  it('X2.2: under crewflow_owner each ops command is placed on the ordinary CLI path (`cli`)', () => {
    for (const command of OPS_COMMANDS) expect(assertOpsPlacement(command, OWNER_ENV)).toBe('cli');
    expect(assertOpsPlacement('user-session:backfill', { PG_DATABASE_URL: 'postgresql://crewflow_owner:pw@db.internal:5432/crewflow?sslmode=verify-full' })).toBe('cli');
  });

  it('the ops container runs only the three ops commands', () => {
    expect(() => assertOpsPlacement('seed', OPS_ENV)).toThrow(/runs only containment:suspend-test-accounts, hws:backfill, user-session:backfill/);
    expect(() => assertOpsPlacement(undefined, OPS_ENV)).toThrow(OpsRunError);
    expect(assertOpsPlacement('hws:backfill', OPS_ENV)).toBe('ops');
  });

  it('an ordinary CLI command refuses any ops variable; without them it is `cli`', () => {
    expect(() => assertOpsPlacement('seed', { CREWFLOW_OPS_ACTOR_ID: 'x' })).toThrow(/refuse the operations-container variable\(s\) CREWFLOW_OPS_ACTOR_ID/);
    expect(assertOpsPlacement('seed', {})).toBe('cli');
  });

  it('a malformed CREWFLOW_OPS_RUN is refused', () => {
    expect(() => assertOpsPlacement('hws:backfill', { ...OPS_ENV, CREWFLOW_OPS_RUN: 'true' })).toThrow(/must be exactly "one-off"/);
  });
});

describe('the operator label (operational, not database-verified)', () => {
  it('is required: each missing variable is named', () => {
    for (const name of Object.keys(LABEL)) {
      const env: Record<string, string | undefined> = { ...LABEL, [name]: '' };
      expect(() => readOpsOperationalLabel(env, 'hws:backfill', 'dry-run')).toThrow(new RegExp(`missing: ${name}`));
    }
  });

  it('refuses an unknown source and malformed id / change reference (no whitespace, no control characters)', () => {
    expect(() => readOpsOperationalLabel({ ...LABEL, CREWFLOW_OPS_ACTOR_SOURCE: 'laptop' }, 'hws:backfill', 'dry-run')).toThrow(/must be one of github-actions, gitlab-ci, manual-console/);
    expect(() => readOpsOperationalLabel({ ...LABEL, CREWFLOW_OPS_ACTOR_ID: 'alice smith' }, 'hws:backfill', 'dry-run')).toThrow(/CREWFLOW_OPS_ACTOR_ID must be/);
    expect(() => readOpsOperationalLabel({ ...LABEL, CREWFLOW_OPS_ACTOR_ID: 'a\nb' }, 'hws:backfill', 'dry-run')).toThrow(/CREWFLOW_OPS_ACTOR_ID must be/);
    expect(() => readOpsOperationalLabel({ ...LABEL, CREWFLOW_OPS_CHANGE_REF: '-rf' }, 'hws:backfill', 'dry-run')).toThrow(/CREWFLOW_OPS_CHANGE_REF must be/);
  });

  it('is recorded verbatim with its fixed note, a run id, and the verified database facts kept apart', () => {
    const label = readOpsOperationalLabel(LABEL, 'user-session:backfill', 'apply');
    expect(label).toMatchObject({
      kind: 'operational-label',
      note: OPS_LABEL_NOTE,
      actorSource: 'github-actions',
      actorId: 'repo:crewflow/rab:environment:production',
      changeRef: 'crewflow/rab#1234',
      command: 'user-session:backfill',
      mode: 'apply',
      path: 'ops-container',
    });
    expect(label.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(OPS_LABEL_NOTE).toBe('operational label, not database-verified identity');
    const metadata = opsAuditMetadata(label, { appLogin: 'crewflow_app', elevatedLogin: 'crewflow_migrator', elevatedRole: 'rab_secure_owner', identity: 'unbound' });
    expect(metadata.operationalLabel).toEqual(label);
    expect(metadata.databaseVerified).toMatchObject({ appLogin: 'crewflow_app', elevatedRole: 'rab_secure_owner' });
  });
});

describe('X2.2: the operator label as flags (owner-login path)', () => {
  it('is required: each missing flag is named, for every ops command', () => {
    for (const command of OPS_COMMANDS) {
      for (const [key, flag] of [['operatorSource', '--operator-source'], ['operatorId', '--operator-id'], ['changeRef', '--change-ref']] as const) {
        expect(() => readOpsLabelFromFlags({ ...FLAGS, [key]: undefined }, command, 'dry-run')).toThrow(new RegExp(`missing: ${flag}`));
        expect(() => readOpsLabelFromFlags({ ...FLAGS, [key]: '   ' }, command, 'dry-run')).toThrow(new RegExp(`missing: ${flag}`));
      }
      expect(() => readOpsLabelFromFlags({}, command, 'dry-run')).toThrow(/missing: --operator-source, --operator-id, --change-ref/);
    }
  });

  it('applies the same value rules as the container variables', () => {
    expect(() => readOpsLabelFromFlags({ ...FLAGS, operatorSource: 'laptop' }, 'hws:backfill', 'dry-run')).toThrow(/--operator-source must be one of github-actions, gitlab-ci, manual-console/);
    expect(() => readOpsLabelFromFlags({ ...FLAGS, operatorId: 'alice smith' }, 'hws:backfill', 'dry-run')).toThrow(/--operator-id must be/);
    expect(() => readOpsLabelFromFlags({ ...FLAGS, changeRef: '-rf' }, 'hws:backfill', 'dry-run')).toThrow(/--change-ref must be/);
  });

  it('records the owner-login path in the label', () => {
    expect(readOpsLabelFromFlags(FLAGS, 'containment:suspend-test-accounts', 'execute')).toMatchObject({
      kind: 'operational-label',
      note: OPS_LABEL_NOTE,
      actorSource: 'manual-console',
      actorId: 'deploy-user@host-1',
      changeRef: 'OPS-42',
      command: 'containment:suspend-test-accounts',
      mode: 'execute',
      path: 'owner-login',
    });
  });
});

describe('ops values never come from a .env file', () => {
  it('refuses any ops name or PG_DATABASE_URL defined in <cwd>/.env; no file is fine', () => {
    expect(() => assertOpsValuesNotFromDotenv('/x', () => 'PG_OPS_APP_DATABASE_URL=postgres://a@b/c\n')).toThrow(/present in a \.env file/);
    expect(() => assertOpsValuesNotFromDotenv('/x', () => 'PG_DATABASE_URL=postgres://a@b/c\n')).toThrow(/PG_DATABASE_URL/);
    expect(() => assertOpsValuesNotFromDotenv('/x', () => 'CREWFLOW_OPS_ACTOR_ID=me\n')).toThrow(/CREWFLOW_OPS_ACTOR_ID/);
    expect(() => assertOpsValuesNotFromDotenv('/x', () => 'REDIS_URL=redis://x\n')).not.toThrow();
    expect(() => assertOpsValuesNotFromDotenv('/x', () => null)).not.toThrow();
  });
});

describe('assertOpsRun (layer 2, every ops command body)', () => {
  const withElevated = { ...OPS_ENV, PG_DATABASE_URL: MIGRATOR };

  it('X2.2: on the CLI path, refuses any login but crewflow_owner even when called directly (every ops command)', () => {
    setPgProcessRole('cli');
    for (const command of OPS_COMMANDS) {
      const env = { PG_DATABASE_URL: APP };
      expect(() => assertOpsRun(command, 'dry-run', { needsElevated: false }, resolvePgEnvironment(env, { processRole: 'cli' }), env, FLAGS)).toThrow(
        /runs only under the owner login crewflow_owner/,
      );
    }
  });

  it('X2.2: refuses a missing label on the owner-login path (every ops command)', () => {
    setPgProcessRole('cli');
    const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: 'cli' });
    for (const command of OPS_COMMANDS) {
      expect(() => assertOpsRun(command, 'dry-run', { needsElevated: true }, resolved, OWNER_ENV)).toThrow(/requires the operator label --operator-source, --operator-id, --change-ref/);
      expect(() => assertOpsRun(command, 'apply', { needsElevated: false }, resolved, OWNER_ENV, { ...FLAGS, changeRef: undefined })).toThrow(/missing: --change-ref/);
    }
  });

  it('X2.2: refuses inside the API, the Worker or the provisioner (a command body reached without main.ts)', () => {
    for (const role of ['api', 'worker', 'provisioner'] as const) {
      setPgProcessRole(role);
      const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: role });
      for (const command of OPS_COMMANDS) {
        expect(() => assertOpsRun(command, 'dry-run', { needsElevated: false }, resolved, OWNER_ENV, FLAGS)).toThrow(new RegExp(`never inside the ${role} process`));
      }
    }
  });

  it('X2.2: refuses a second endpoint on the owner-login path', () => {
    setPgProcessRole('cli');
    const withUnpooled = { ...OWNER_ENV, DATABASE_URL_UNPOOLED: 'postgres://postgres:pw-su-1@localhost:5432/rab' };
    expect(() => assertOpsRun('user-session:backfill', 'apply', { needsElevated: true }, resolvePgEnvironment(withUnpooled, { processRole: 'cli' }), withUnpooled, FLAGS)).toThrow(
      /DATABASE_URL_UNPOOLED/,
    );
  });

  it('X2.2: accepts crewflow_owner with the label; needsElevated asks for no second credential there', () => {
    setPgProcessRole('cli');
    const resolved = resolvePgEnvironment(OWNER_ENV, { processRole: 'cli' });
    expect(assertOpsRun('containment:suspend-test-accounts', 'execute', { needsElevated: true }, resolved, OWNER_ENV, FLAGS)).toMatchObject({ path: 'owner-login', mode: 'execute' });
    expect(assertOpsRun('user-session:backfill', 'verify', { needsElevated: false }, resolved, OWNER_ENV, FLAGS).path).toBe('owner-login');
    expect(assertOpsRun('hws:backfill', 'apply', { needsElevated: false }, resolved, OWNER_ENV, FLAGS).command).toBe('hws:backfill');
  });

  it('the ops container refuses the label flags (its label comes from its variables only)', () => {
    setPgProcessRole('ops');
    expect(() => assertOpsRun('hws:backfill', 'dry-run', { needsElevated: false }, resolvePgEnvironment(OPS_ENV, { processRole: 'ops' }), OPS_ENV, FLAGS)).toThrow(
      /remove --operator-source \/ --operator-id \/ --change-ref/,
    );
  });

  it('minimum privilege: PG_DATABASE_URL present exactly when the mode needs the elevated session', () => {
    setPgProcessRole('ops');
    const resolvedWith = resolvePgEnvironment(withElevated, { processRole: 'ops' });
    const resolvedWithout = resolvePgEnvironment(OPS_ENV, { processRole: 'ops' });
    expect(() => assertOpsRun('user-session:backfill', 'verify', { needsElevated: false }, resolvedWith, withElevated)).toThrow(/Remove PG_DATABASE_URL/);
    expect(() => assertOpsRun('hws:backfill', 'apply', { needsElevated: false }, resolvedWith, withElevated)).toThrow(/Remove PG_DATABASE_URL/);
    expect(() => assertOpsRun('containment:suspend-test-accounts', 'dry-run', { needsElevated: true }, resolvedWithout, OPS_ENV)).toThrow(
      /needs the verified elevated session/,
    );
    expect(assertOpsRun('user-session:backfill', 'verify', { needsElevated: false }, resolvedWithout, OPS_ENV).command).toBe('user-session:backfill');
    expect(assertOpsRun('user-session:backfill', 'apply', { needsElevated: true }, resolvedWith, withElevated).mode).toBe('apply');
  });

  it('refuses a missing operator label', () => {
    setPgProcessRole('ops');
    const env = { CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: APP };
    expect(() => assertOpsRun('hws:backfill', 'dry-run', { needsElevated: false }, resolvePgEnvironment(env, { processRole: 'ops' }), env)).toThrow(
      /requires the operator label/,
    );
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
