import { PgConfigError, PgEndpoint, resolvePgEnvironment } from '../postgres';
import { matchUnmarkedProductionEndpoint, unmarkedProductionRefusal } from './unmarked-production-endpoints';

/**
 * Security review N-1: the interim unmarked-production deny list (neon:ep-round-rain-aess0njf) must hold for every spelling
 * that reaches the same Neon endpoint — a trailing-dot host and Neon password routing (`endpoint=<id>$<password>`) — and
 * never print the password. Fake credentials only.
 */
const SECRET = 'S3cret-PW-do-not-print';
const PROD_HOST = 'ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech';

const resolve = (url: string) => resolvePgEnvironment({ NODE_ENV: 'development', PG_DATABASE_URL: url }, { processRole: 'api' });

describe('unmarkedProductionRefusal (security review N-1)', () => {
  it.each([
    ['the plain direct host', `postgres://crewflow_app:${SECRET}@${PROD_HOST}/neondb?sslmode=require`],
    ['a trailing-dot direct host', `postgres://crewflow_app:${SECRET}@${PROD_HOST}./neondb?sslmode=require`],
    ['a trailing-dot pooled host', `postgres://crewflow_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech./neondb`],
    ['Neon password routing ($) on the production host', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@${PROD_HOST}/neondb`],
    ['Neon password routing (;) on the trailing-dot production host', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%3B${SECRET}@${PROD_HOST}./other_db`],
  ])('refuses %s, naming the endpoint and never the password', (_name, url) => {
    const message = unmarkedProductionRefusal(resolve(url), 'api process');
    expect(message).toMatch(/^PG_DATABASE_URL names the current production Neon endpoint .*\(neon:ep-round-rain-aess0njf, database /);
    expect(message).not.toContain(SECRET);
    expect(message).not.toMatch(/postgres:\/\//);
  });

  it.each([
    ['an IP literal', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@10.0.0.5/neondb`],
    ['a loopback tunnel', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@127.0.0.1:15432/neondb`],
    ['an alias host', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@prod-alias.example.net/neondb`],
  ])('password routing to the production endpoint through %s is refused by the URL policy before the deny list is even asked', (_name, url) => {
    let caught: unknown;
    try {
      resolve(url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PgConfigError);
    expect((caught as Error).message).toMatch(/Neon password routing/);
    expect((caught as Error).message).not.toContain(SECRET);
  });

  it('defence in depth: the routed endpoint alone matches the deny list, whatever the host key says', () => {
    const endpoint = resolve(`postgres://crewflow_app:${SECRET}@10.0.0.5/neondb`).primary;
    expect(matchUnmarkedProductionEndpoint(endpoint)).toBeNull();
    const forged: PgEndpoint = { ...endpoint, target: { ...endpoint.target, routedNeonEndpoint: 'EP-ROUND-RAIN-AESS0NJF' } };
    expect(matchUnmarkedProductionEndpoint(forged)?.endpointKey).toBe('neon:ep-round-rain-aess0njf');
  });

  it('another Neon endpoint, with or without password routing to itself, is not on the list', () => {
    const other = 'ep-other-endpoint-xyz.c-2.us-east-2.aws.neon.tech';
    expect(unmarkedProductionRefusal(resolve(`postgres://u:${SECRET}@${other}./neondb`), 'api process')).toBeNull();
    expect(unmarkedProductionRefusal(resolve(`postgres://u:endpoint%3Dep-other-endpoint-xyz%24${SECRET}@${other}/neondb`), 'api process')).toBeNull();
  });
});
