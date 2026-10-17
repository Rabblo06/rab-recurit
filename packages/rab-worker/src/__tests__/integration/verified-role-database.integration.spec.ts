import {
  resolveVerifiedRoleDatabaseUrl,
  verifiedRestrictedRuntimeUrl,
} from './helpers/verified-role-database';

/**
 * The verified-role helper is what keeps worker tests on the isolated test database. Every refusal path is asserted here,
 * against the real test server: a test that cannot prove its target must fail, never skip and never connect elsewhere.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('verified test-database role helper (fail closed)', () => {
  const PROBE = 'TEST_VERIFIED_ROLE_PROBE_URL';
  afterEach(() => {
    delete process.env[PROBE];
  });

  it('accepts the verified restricted runtime role on the test database', async () => {
    await expect(verifiedRestrictedRuntimeUrl()).resolves.toBe(
      process.env.TEST_DATABASE_URL,
    );
  });

  it('refuses when the variable is missing (no fallback to DATABASE_URL or .env)', async () => {
    await expect(
      resolveVerifiedRoleDatabaseUrl(PROBE, 'crewflow'),
    ).rejects.toThrow(/is required/);
  });

  it('refuses a superuser login presented as the restricted role', async () => {
    process.env[PROBE] = process.env.TEST_DATABASE_URL_UNPOOLED;
    await expect(
      resolveVerifiedRoleDatabaseUrl(PROBE, 'crewflow_app'),
    ).rejects.toThrow(/without SUPERUSER or BYPASSRLS \(got a superuser\)/);
  });

  it('refuses the right role on a different database in the same cluster', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = '/postgres';
    process.env[PROBE] = url.toString();
    await expect(
      resolveVerifiedRoleDatabaseUrl(PROBE, 'crewflow_app'),
    ).rejects.toThrow(/not the test database/);
  });

  it('refuses a remote host unless explicitly allowed', async () => {
    process.env[PROBE] = 'postgres://someone:secret@db.example.com:5432/rab';
    const error = await resolveVerifiedRoleDatabaseUrl(PROBE, 'crewflow').catch(
      (e: Error) => e,
    );
    expect(String(error)).toMatch(/remote host/);
    // Messages never echo credentials.
    expect(String(error)).not.toMatch(/secret|someone/);
  });
});
