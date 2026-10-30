import { seedAiDemoTargetProblems } from './seed-ai-demo.command';

/** `seed-ai-demo` refuses everything that is not identified as the development database (owner decision 9). */
describe('seed-ai-demo target rules', () => {
  const dev = { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DB_TARGET: 'local', DATABASE_URL: 'postgres://crewflow:pw@127.0.0.1:15432/rab' };

  it('accepts only the development declaration on a local database', () => {
    expect(seedAiDemoTargetProblems(dev)).toEqual([]);
    expect(seedAiDemoTargetProblems({ ...dev, DATABASE_URL: 'postgres://crewflow:pw@devdb:5432/rab' })).toEqual([]);
  });

  it.each([
    ['NODE_ENV=test', { NODE_ENV: 'test' }, /NODE_ENV must be development/],
    ['NODE_ENV=production', { NODE_ENV: 'production' }, /NODE_ENV must be development/],
    ['DB_TARGET=test', { DB_TARGET: 'test' }, /DB_TARGET must be local/],
    ['DB_TARGET=production', { DB_TARGET: 'production' }, /DB_TARGET must be local/],
    ['DB_TARGET unset', { DB_TARGET: undefined }, /DB_TARGET must be local/],
    ['RAB_RUNTIME_ENV unset', { RAB_RUNTIME_ENV: undefined }, /RAB_RUNTIME_ENV must be development/],
    ['a remote host', { DATABASE_URL: 'postgres://crewflow:pw@ep-round-rain-aess0njf.eu.aws.neon.tech/neondb' }, /loopback or docker-service/],
    // Final review F4: an unlisted single-label host (DNS search domain / k8s namespace) and a non-loopback IPv6 literal.
    ['an unlisted single-label host', { DATABASE_URL: 'postgres://crewflow:pw@db:5432/rab' }, /loopback or docker-service/],
    ['a non-loopback IPv6 literal', { DATABASE_URL: 'postgres://crewflow:pw@[fd00::5]:5432/rab' }, /loopback or docker-service/],
    ['no URL', { DATABASE_URL: undefined }, /DATABASE_URL is required/],
  ])('refuses %s', (_label, extra, message) => {
    const problems = seedAiDemoTargetProblems({ ...dev, ...extra });
    expect(problems.join('\n')).toMatch(message);
    expect(problems.join('\n')).not.toContain('pw@');
  });
});
