import { MFA_VERIFIED_IMMUTABLE_UP_SQL } from './grant-parity-guard-sql';
import { R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS } from './secure-owner-invariants';

/**
 * Agent 1, 2026-11-04: the MFA-SESS-1 function is owned by rab_secure_owner, and R4 matches crewflow-owned core table
 * names as whole words anywhere in such a body (string literals included). Its message 'permission denied: …' read as
 * core.permission and failed every fresh chain build at OwnerLoginGrantParityGuards1786721420000 (PG16 and PG18).
 */
describe('MFA-SESS-1 function body names no crewflow-owned core table (R4)', () => {
  const body = MFA_VERIFIED_IMMUTABLE_UP_SQL[0];

  it('is the rab_secure_owner function body', () => {
    expect(body).toMatch(/CREATE FUNCTION core\.user_session_mfa_verified_immutable\(\)/);
    expect(MFA_VERIFIED_IMMUTABLE_UP_SQL).toContain('ALTER FUNCTION core.user_session_mfa_verified_immutable() OWNER TO rab_secure_owner');
  });

  // `permission` is crewflow-owned global reference data; the frozen R4 list must not grow through this function either.
  it.each(['permission', ...R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS])('does not name %s', (table) => {
    expect(body).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])(core\\.)?"?${table}"?([^A-Za-z0-9_]|$)`, 'i'));
  });

  it('still refuses with SQLSTATE 42501', () => {
    expect(body).toContain("USING ERRCODE = '42501'");
  });
});
