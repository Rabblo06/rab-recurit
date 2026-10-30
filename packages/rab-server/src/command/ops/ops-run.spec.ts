import { resolvePgEnvironment, setPgProcessRole } from '../../database/postgres/pg-config';
import { assertHwsApplyAllowed } from './hws-cutover-policy';
import {
  assertOpsPlacement,
  assertOpsRun,
  assertOpsValuesNotFromDotenv,
  OPS_LABEL_NOTE,
  opsAuditMetadata,
  OpsRunError,
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

afterEach(() => setPgProcessRole('api'));

describe('ops placement (command/main.ts)', () => {
  it('an ops command outside the ops container is refused', () => {
    expect(() => assertOpsPlacement('containment:suspend-test-accounts', { PG_DATABASE_URL: APP })).toThrow(/runs only in the one-off operations container/);
    expect(() => assertOpsPlacement('hws:backfill', {})).toThrow(OpsRunError);
    expect(() => assertOpsPlacement('user-session:backfill', {})).toThrow(OpsRunError);
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
    });
    expect(label.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(OPS_LABEL_NOTE).toBe('operational label, not database-verified identity');
    const metadata = opsAuditMetadata(label, { appLogin: 'crewflow_app', elevatedLogin: 'crewflow_migrator', elevatedRole: 'rab_secure_owner', identity: 'unbound' });
    expect(metadata.operationalLabel).toEqual(label);
    expect(metadata.databaseVerified).toMatchObject({ appLogin: 'crewflow_app', elevatedRole: 'rab_secure_owner' });
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

  it('refuses outside the ops process even when called directly', () => {
    setPgProcessRole('cli');
    expect(() => assertOpsRun('hws:backfill', 'dry-run', { needsElevated: false }, resolvePgEnvironment({ PG_DATABASE_URL: APP }, { processRole: 'cli' }), {})).toThrow(
      /runs only in the one-off operations container/,
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
