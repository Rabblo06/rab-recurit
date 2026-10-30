import { validate } from './env.validation';

// Phase B (B1): env.validation runs the database rules from src/database/postgres/pg-config.ts at boot.
const base = { REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };
const PG = 'postgres://crewflow_app:pg-secret@localhost:5432/rab';

describe('env validation: database configuration (Phase B)', () => {
  it('accepts PG_DATABASE_URL alone, and the legacy DATABASE_URL alone outside production', () => {
    expect(() => validate({ ...base, PG_DATABASE_URL: PG })).not.toThrow();
    expect(() => validate({ ...base, DATABASE_URL: PG })).not.toThrow();
  });

  it('refuses a missing database URL, naming both variables', () => {
    expect(() => validate(base)).toThrow(/PG_DATABASE_URL is required.*DATABASE_URL/);
  });

  it('refuses PG_DATABASE_URL and DATABASE_URL naming different targets, without echoing either', () => {
    try {
      validate({ ...base, PG_DATABASE_URL: PG, DATABASE_URL: 'postgres://crewflow_app:other-secret@localhost:5432/other' });
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/name different targets/);
      expect(message).not.toMatch(/pg-secret|other-secret|crewflow_app/);
    }
  });

  it('refuses a non-numeric or out-of-range pool size instead of falling back (the old DB_POOL_MAX bug)', () => {
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_POOL_MAX_CONNECTIONS: 'abc' })).toThrow(/PG_POOL_MAX_CONNECTIONS/);
    expect(() => validate({ ...base, DATABASE_URL: PG, DB_POOL_MAX: '2.5' })).toThrow(/DB_POOL_MAX must be a whole number/);
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_POOL_MAX_CONNECTIONS: '0' })).toThrow(/between 1 and 100/);
  });

  it('refuses a URL query parameter that overrides the target', () => {
    expect(() => validate({ ...base, PG_DATABASE_URL: `${PG}?host=evil.example.com` })).toThrow(/override the connection target/);
  });

  it('production refuses the legacy names and reports it with the other production refusals', () => {
    expect(() => validate({ ...base, NODE_ENV: 'production', PG_DATABASE_URL: PG, DATABASE_URL: PG })).toThrow(
      /for production:[\s\S]*refuses the legacy database variable\(s\) DATABASE_URL/,
    );
  });

  it('Phase B (B5): the connection-budget shape keys are strict whole numbers within their ranges', () => {
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_EXPECTED_API_INSTANCES: '2', PG_EXPECTED_WORKER_INSTANCES: '1', PG_EXPECTED_API_POOL_MAX: '9', PG_EXPECTED_WORKER_POOL_MAX: '12', PG_EXPECTED_MIGRATE_CONNECTIONS: '3', PG_PROVIDER_RESERVED_CONNECTIONS: '0' })).not.toThrow();
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_EXPECTED_API_INSTANCES: 'two' })).toThrow(/PG_EXPECTED_API_INSTANCES must be a whole number/);
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_EXPECTED_WORKER_POOL_MAX: '1.5' })).toThrow(/PG_EXPECTED_WORKER_POOL_MAX must be a whole number/);
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_EXPECTED_API_POOL_MAX: '0' })).toThrow(/PG_EXPECTED_API_POOL_MAX must be between 1 and 100/);
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_PROVIDER_RESERVED_CONNECTIONS: '-1' })).toThrow(/PG_PROVIDER_RESERVED_CONNECTIONS must be a whole number/);
  });
});
