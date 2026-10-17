import { assertMigrationIdentity, MigrationIdentityError, MigrationIdentityFacts } from './migration-identity';

const facts = (over: Partial<MigrationIdentityFacts>): MigrationIdentityFacts => ({
  currentUser: 'x',
  isSuperuser: false,
  roleSplitApplied: true,
  canActAsOwnerRoles: false,
  pendingMigrations: 1,
  pendingBeforeRoleSplit: 0,
  ...over,
});

describe('assertMigrationIdentity (CF-41 migration identity sequence)', () => {
  it('allows anything when nothing is pending', () => {
    expect(() => assertMigrationIdentity(facts({ pendingMigrations: 0, currentUser: 'crewflow' }))).not.toThrow();
  });

  it('phase A: refuses a superuser before the role split (that build leaves the runtime roles without table privileges)', () => {
    expect(() => assertMigrationIdentity(facts({ roleSplitApplied: false, pendingBeforeRoleSplit: 128, isSuperuser: true, currentUser: 'rab' }))).toThrow(
      MigrationIdentityError,
    );
  });

  it('phase A: allows the database owner role before the role split', () => {
    expect(() => assertMigrationIdentity(facts({ roleSplitApplied: false, pendingBeforeRoleSplit: 128, currentUser: 'rab_owner' }))).not.toThrow();
  });

  it('phase B: refuses the ordinary crewflow credential', () => {
    expect(() => assertMigrationIdentity(facts({ currentUser: 'crewflow' }))).toThrow(/bootstrap identity/);
  });

  it('phase B: allows a superuser, or a non-superuser that can act as both owner roles', () => {
    expect(() => assertMigrationIdentity(facts({ isSuperuser: true }))).not.toThrow();
    expect(() => assertMigrationIdentity(facts({ canActAsOwnerRoles: true, currentUser: 'migrator' }))).not.toThrow();
  });

  it('boundary: once phase A is complete (only the split and later pending) the bootstrap superuser may proceed', () => {
    expect(() =>
      assertMigrationIdentity(facts({ roleSplitApplied: false, pendingBeforeRoleSplit: 0, pendingMigrations: 44, isSuperuser: true, currentUser: 'rab' })),
    ).not.toThrow();
  });

  it('boundary: a superuser is still refused while even one phase-A migration remains', () => {
    expect(() => assertMigrationIdentity(facts({ roleSplitApplied: false, pendingBeforeRoleSplit: 1, isSuperuser: true, currentUser: 'rab' }))).toThrow(
      /phase-A migration/,
    );
  });
});
