import {
  assertOpsActingFacts,
  assertOpsLoginFacts,
  ElevatedOpsSessionError,
  OpsSessionExpectation,
  OpsSessionFacts,
  parseOpsSessionFacts,
} from './elevated-ops-session';
import { OPS_ELEVATED_PLANS, OPS_STATEMENTS } from './ops-statements';

// Phase B ops container: the elevated-session verification DECISIONS (the live SQL is exercised by
// __tests__/integration/ops-elevated-session.integration.spec.ts on a disposable database).
const EXPECT: OpsSessionExpectation = { expectedLogin: 'crewflow_migrator', expectedDatabase: 'rab', role: 'rab_secure_owner', readOnly: true };

const BEFORE: OpsSessionFacts = {
  login: 'crewflow_migrator',
  acting: 'crewflow_migrator',
  loginCanLogin: true,
  loginExempt: false,
  loginMemberSecureOwner: true,
  loginMemberCrewflow: true,
  loginAdminOption: false,
  canSetRole: true,
  actingExempt: false,
  actingHasCrewflow: true,
  actingHasSecureOwner: true,
  actingHasApp: false,
  readOnly: true,
  serverVersionNum: 160004,
  database: 'rab',
};
const AFTER: OpsSessionFacts = { ...BEFORE, acting: 'rab_secure_owner', actingHasCrewflow: false, actingHasSecureOwner: true };

describe('elevated ops session: before narrowing', () => {
  it('accepts the migration identity shape', () => {
    expect(() => assertOpsLoginFacts(BEFORE, EXPECT)).not.toThrow();
  });

  it.each<[string, Partial<OpsSessionFacts>, Partial<OpsSessionExpectation>, RegExp]>([
    ['wrong session_user (not the URL login)', { login: 'someone_else', acting: 'someone_else' }, {}, /session_user is not the login named by PG_DATABASE_URL/],
    ['the runtime login', { login: 'crewflow_app', acting: 'crewflow_app' }, { expectedLogin: 'crewflow_app' }, /must be the migration identity, not "crewflow_app"/],
    ['the owner login itself', { login: 'crewflow', acting: 'crewflow' }, { expectedLogin: 'crewflow' }, /not "crewflow"/],
    ['SUPERUSER / BYPASSRLS', { loginExempt: true }, {}, /SUPERUSER or BYPASSRLS/],
    ['not a member of both owner roles', { loginMemberCrewflow: false }, {}, /migration-identity shape/],
    ['an ADMIN option', { loginAdminOption: true }, {}, /ADMIN option/],
    ['missing SET membership (PG16 SET FALSE)', { canSetRole: false }, {}, /may not SET ROLE rab_secure_owner/],
    ['already acting as another role', { acting: 'crewflow' }, {}, /already acting as another role/],
    ['PostgreSQL 15', { serverVersionNum: 150008 }, {}, /below 160000/],
    ['another database', { database: 'other' }, {}, /differs from the app session/],
    ['READ WRITE where READ ONLY is required', { readOnly: false }, {}, /requires READ ONLY/],
  ])('refuses %s', (_name, facts, expect_, pattern) => {
    expect(() => assertOpsLoginFacts({ ...BEFORE, ...facts }, { ...EXPECT, ...expect_ })).toThrow(pattern);
  });
});

describe('elevated ops session: after SET LOCAL ROLE', () => {
  it('accepts rab_secure_owner, narrowed, read-only', () => {
    expect(() => assertOpsActingFacts(AFTER, EXPECT)).not.toThrow();
  });

  it.each<[string, Partial<OpsSessionFacts>, Partial<OpsSessionExpectation>, RegExp]>([
    ['unnarrowed (still the login)', { acting: 'crewflow_migrator', actingHasCrewflow: true }, {}, /not the intended narrow role "rab_secure_owner" \(unnarrowed or wrong role\)/],
    ['the wrong narrow role', { acting: 'crewflow' }, {}, /current_user is "crewflow"/],
    ['rab_secure_owner still holding crewflow', { actingHasCrewflow: true }, {}, /still holds crewflow privileges/],
    ['crewflow still holding rab_secure_owner', { acting: 'crewflow', actingHasSecureOwner: true }, { role: 'crewflow' }, /still holds rab_secure_owner privileges/],
    ['a SUPERUSER / BYPASSRLS narrow role', { actingExempt: true }, {}, /SUPERUSER or BYPASSRLS/],
    ['a narrow role inside crewflow_app', { actingHasApp: true }, {}, /member of crewflow_app/],
    ['READ WRITE where READ ONLY is required', { readOnly: false }, {}, /requires READ ONLY/],
    ['READ ONLY where READ WRITE is required', { readOnly: true }, { readOnly: false }, /requires READ WRITE/],
    ['another session user', { login: 'x' }, {}, /session_user changed/],
  ])('refuses %s', (_name, facts, expect_, pattern) => {
    expect(() => assertOpsActingFacts({ ...AFTER, ...facts }, { ...EXPECT, ...expect_ })).toThrow(pattern);
  });

  it('parses the query row strictly (missing row refuses; read_only "on" only)', () => {
    expect(() => parseOpsSessionFacts(undefined)).toThrow(ElevatedOpsSessionError);
    expect(parseOpsSessionFacts({ login: 'a', acting: 'a', read_only: 'off', server_version_num: '160000', database: 'rab' }).readOnly).toBe(false);
    expect(parseOpsSessionFacts({ login: 'a', acting: 'a', read_only: 'on', can_set_role: 't' }).canSetRole).toBe(false);
  });
});

describe('the frozen statement list and plans', () => {
  it('every plan statement exists, read and write lists are disjoint, and only user-session apply may write', () => {
    for (const plan of Object.values(OPS_ELEVATED_PLANS)) {
      for (const name of [...plan.readStatements, ...plan.writeStatements]) expect(OPS_STATEMENTS[name]).toEqual(expect.any(String));
      expect(plan.readStatements.filter((n) => (plan.writeStatements as readonly string[]).includes(n))).toEqual([]);
      expect(plan.role).toBe('rab_secure_owner');
    }
    expect(OPS_ELEVATED_PLANS.containment.writeStatements).toEqual([]);
    expect(OPS_ELEVATED_PLANS['user-session-scan'].writeStatements).toEqual([]);
    expect(OPS_ELEVATED_PLANS['user-session-apply'].writeStatements).toEqual(['user-session-backfill.bind-family', 'user-session-backfill.insert-family']);
  });

  it('the registry and plans are frozen (no runtime additions)', () => {
    expect(Object.isFrozen(OPS_STATEMENTS)).toBe(true);
    expect(Object.isFrozen(OPS_ELEVATED_PLANS.containment)).toBe(true);
    expect(Object.isFrozen(OPS_ELEVATED_PLANS.containment.readStatements)).toBe(true);
  });

  it('every read statement of a READ ONLY plan is a SELECT', () => {
    for (const name of [...OPS_ELEVATED_PLANS.containment.readStatements, ...OPS_ELEVATED_PLANS['user-session-scan'].readStatements]) {
      expect(OPS_STATEMENTS[name].trim()).toMatch(/^SELECT /);
    }
  });
});
