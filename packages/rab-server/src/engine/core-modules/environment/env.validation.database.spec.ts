import { validate } from './env.validation';

// Phase B (B1): env.validation runs the database rules from src/database/postgres/pg-config.ts at boot.
const base = { REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };
const PG = 'postgres://crewflow_app:pg-secret@localhost:5432/rab';

describe('env validation: database configuration (Phase B)', () => {
  it('accepts PG_DATABASE_URL alone', () => {
    expect(() => validate({ ...base, PG_DATABASE_URL: PG })).not.toThrow();
  });

  it('X3.5-S8: refuses the legacy DATABASE_URL alone outside production, naming the replacement and never the value', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      try {
        validate({ ...base, NODE_ENV, DATABASE_URL: PG });
        throw new Error('expected a refusal');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/refuses the legacy database variable\(s\) DATABASE_URL: .*DATABASE_URL -> use PG_DATABASE_URL/);
        expect(message).not.toMatch(/pg-secret|crewflow_app/);
      }
    }
  });

  it('refuses a missing database URL', () => {
    expect(() => validate(base)).toThrow(/PG_DATABASE_URL is required/);
  });

  it('X3.5-S8: refuses DATABASE_URL next to PG_DATABASE_URL even when both name the same target, without echoing either', () => {
    for (const legacy of [PG, 'postgres://crewflow_app:other-secret@localhost:5432/other']) {
      try {
        validate({ ...base, PG_DATABASE_URL: PG, DATABASE_URL: legacy });
        throw new Error('expected a refusal');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/refuses the legacy database variable\(s\) DATABASE_URL/);
        expect(message).not.toMatch(/pg-secret|other-secret|crewflow_app/);
      }
    }
  });

  it('refuses a non-numeric or out-of-range pool size instead of falling back; the legacy DB_POOL_MAX is refused outright', () => {
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, PG_POOL_MAX_CONNECTIONS: 'abc' })).toThrow(/PG_POOL_MAX_CONNECTIONS/);
    expect(() => validate({ ...base, PG_DATABASE_URL: PG, DB_POOL_MAX: '5' })).toThrow(/DB_POOL_MAX -> use PG_POOL_MAX_CONNECTIONS/);
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
