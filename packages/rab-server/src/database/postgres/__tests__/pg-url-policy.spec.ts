import { describePgTarget, detectTransactionPooler, parsePgUrl, PgConfigError, redactPgUrl } from '../pg-url-policy';

// Phase B (B1/B2): the URL parameter policy. Provider shapes are the documented connection-string formats; the
// credentials are fakes, and every refusal is checked for leaking them.
const SECRET = 'Pw-s3cret-9f';

describe('pg-url-policy: provider connection strings', () => {
  it.each([
    [
      'Neon pooled (-pooler, sslmode=require, channel_binding=require)',
      `postgresql://neondb_owner:${SECRET}@ep-cool-darkness-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`,
      { host: 'ep-cool-darkness-123456-pooler.eu-west-2.aws.neon.tech', port: 5432, user: 'neondb_owner', database: 'neondb', sslmode: 'require', channelBinding: true, pooler: 'neon' },
    ],
    [
      'Neon direct with the SNI workaround options=endpoint%3D<id>',
      `postgresql://neondb_owner:${SECRET}@ep-cool-darkness-123456.eu-west-2.aws.neon.tech/neondb?sslmode=verify-full&options=endpoint%3Dep-cool-darkness-123456`,
      { host: 'ep-cool-darkness-123456.eu-west-2.aws.neon.tech', port: 5432, user: 'neondb_owner', database: 'neondb', sslmode: 'verify-full', channelBinding: false, pooler: null },
    ],
    [
      'Supabase direct db.<ref>.supabase.co:5432',
      `postgresql://postgres:${SECRET}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres`,
      { host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432, user: 'postgres', database: 'postgres', sslmode: null, channelBinding: false, pooler: null },
    ],
    [
      'Supabase transaction pooler aws-0-<region>.pooler.supabase.com:6543, user postgres.<ref>',
      `postgresql://postgres.abcdefghijklmnopqrst:${SECRET}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
      { host: 'aws-0-eu-west-2.pooler.supabase.com', port: 6543, user: 'postgres.abcdefghijklmnopqrst', database: 'postgres', sslmode: null, channelBinding: false, pooler: 'supabase' },
    ],
    [
      'Supabase session pooler on :5432 (session mode, not denylisted)',
      `postgresql://postgres.abcdefghijklmnopqrst:${SECRET}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,
      { host: 'aws-0-eu-west-2.pooler.supabase.com', port: 5432, user: 'postgres.abcdefghijklmnopqrst', database: 'postgres', sslmode: null, channelBinding: false, pooler: null },
    ],
    [
      'DigitalOcean managed direct port 25060, defaultdb, sslmode=require',
      `postgresql://doadmin:${SECRET}@db-postgresql-lon1-12345-do-user-1.db.ondigitalocean.com:25060/defaultdb?sslmode=require`,
      { host: 'db-postgresql-lon1-12345-do-user-1.db.ondigitalocean.com', port: 25060, user: 'doadmin', database: 'defaultdb', sslmode: 'require', channelBinding: false, pooler: null },
    ],
    [
      'DigitalOcean connection pool port 25061',
      `postgresql://doadmin:${SECRET}@db-postgresql-lon1-12345-do-user-1.db.ondigitalocean.com:25061/app-pool?sslmode=require`,
      { host: 'db-postgresql-lon1-12345-do-user-1.db.ondigitalocean.com', port: 25061, user: 'doadmin', database: 'app-pool', sslmode: 'require', channelBinding: false, pooler: 'digitalocean' },
    ],
    [
      'AWS RDS instance',
      `postgresql://app:${SECRET}@mydb.abc123xyz.eu-west-2.rds.amazonaws.com:5432/app?sslmode=verify-full`,
      { host: 'mydb.abc123xyz.eu-west-2.rds.amazonaws.com', port: 5432, user: 'app', database: 'app', sslmode: 'verify-full', channelBinding: false, pooler: null },
    ],
    [
      'AWS RDS Proxy',
      `postgresql://app:${SECRET}@myproxy.proxy-abc123xyz.eu-west-2.rds.amazonaws.com:5432/app`,
      { host: 'myproxy.proxy-abc123xyz.eu-west-2.rds.amazonaws.com', port: 5432, user: 'app', database: 'app', sslmode: null, channelBinding: false, pooler: 'rds-proxy' },
    ],
    [
      'self-hosted localhost:5432',
      `postgres://crewflow_app:${SECRET}@localhost:5432/rab`,
      { host: 'localhost', port: 5432, user: 'crewflow_app', database: 'rab', sslmode: null, channelBinding: false, pooler: null },
    ],
  ])('%s', (_name, url, expected) => {
    const t = parsePgUrl(url, 'PG_DATABASE_URL');
    expect({
      host: t.host,
      port: t.port,
      user: t.user,
      database: t.database,
      sslmode: t.sslmode,
      channelBinding: t.channelBinding,
      pooler: t.transactionPooler?.provider ?? null,
    }).toEqual(expected);
    expect(t.password).toBe(SECRET);
    // The password never appears in an enumerable field (JSON.stringify of the target, a log line).
    expect(JSON.stringify(t)).not.toContain(SECRET);
    expect(t.display).toBe(`${expected.host}:${expected.port}/${expected.database}`);
  });

  it('keeps the Neon endpoint token for the startup options, and defaults the port to 5432', () => {
    const t = parsePgUrl(`postgresql://u:${SECRET}@ep-cool-darkness-123456.eu-west-2.aws.neon.tech/neondb?options=endpoint%3Dep-cool-darkness-123456`, 'X');
    expect(t.providerOptions).toBe('endpoint=ep-cool-darkness-123456');
    expect(t.port).toBe(5432);
  });

  it('flags PgBouncer\'s default port 6432 as a suspicion (warning), not a refusal', () => {
    const t = parsePgUrl(`postgres://u:${SECRET}@db.internal.example:6432/rab`, 'X');
    expect(t.transactionPooler).toBeNull();
    expect(t.poolerSuspicion).toMatch(/6432/);
  });

  it('accepts the benign provider boilerplate (ignored) and application_name', () => {
    const t = parsePgUrl(
      `postgres://u:${SECRET}@localhost/rab?connect_timeout=10&keepalives=1&keepalives_idle=30&application_name=ops-shell&target_session_attrs=any`,
      'X',
    );
    expect(t.applicationName).toBe('ops-shell');
  });

  it('detectTransactionPooler only matches the documented shapes', () => {
    expect(detectTransactionPooler('ep-x-pooler.c-2.eu-west-2.aws.neon.tech', 5432)?.provider).toBe('neon');
    expect(detectTransactionPooler('ep-x.c-2.eu-west-2.aws.neon.tech', 5432)).toBeNull();
    expect(detectTransactionPooler('pooler.example.com', 6543)).toBeNull();
    expect(detectTransactionPooler('x.db.ondigitalocean.com', 25060)).toBeNull();
  });
});

describe('pg-url-policy: refusals (target and security overrides), never echoing the value', () => {
  const base = `postgres://secretuser:${SECRET}@localhost:5432/rab`;
  it.each([
    ['?host= (target override, F1)', `${base}?host=evil.example.com`, /override the connection target/],
    ['?hostaddr=', `${base}?hostaddr=10.0.0.9`, /override the connection target/],
    ['?port=', `${base}?port=6543`, /override the connection target/],
    ['?user=', `${base}?user=postgres`, /override the connection target/],
    ['?dbname=', `${base}?dbname=other`, /override the connection target/],
    ['?database=', `${base}?database=other`, /override the connection target/],
    ['?password=', `${base}?password=x`, /override the connection target/],
    ['?sslrootcert=', `${base}?sslmode=verify-full&sslrootcert=/tmp/ca.pem`, /override the TLS settings/],
    ['?sslcert=', `${base}?sslcert=/tmp/c.pem`, /override the TLS settings/],
    ['?sslkey=', `${base}?sslkey=/tmp/k.pem`, /override the TLS settings/],
    ['?sslcrl=', `${base}?sslcrl=/tmp/crl.pem`, /override the TLS settings/],
    ['?sslpassword=', `${base}?sslpassword=x`, /override the TLS settings/],
    ['?ssl=', `${base}?ssl=true`, /override the TLS settings/],
    ['?sslnegotiation=', `${base}?sslnegotiation=direct`, /override the TLS settings/],
    ['?uselibpqcompat=', `${base}?uselibpqcompat=true&sslmode=require`, /override the TLS settings/],
    ['options=-c role=…', `${base}?options=-c%20role%3Dcrewflow`, /Only a Neon endpoint/],
    ['options=-c search_path=…', `${base}?options=-c%20search_path%3Dpublic`, /Only a Neon endpoint/],
    ['a Neon endpoint token on a non-Neon host', `${base}?options=endpoint%3Dep-x`, /Only a Neon endpoint/],
    [
      'a Neon endpoint token naming a DIFFERENT endpoint than the host',
      `postgres://secretuser:${SECRET}@ep-aaa-111.eu-west-2.aws.neon.tech/neondb?options=endpoint%3Dep-bbb-222`,
      /Only a Neon endpoint/,
    ],
    ['an unknown parameter', `${base}?pgbouncer=true`, /unsupported query parameter "pgbouncer"/],
    ['a repeated parameter', `${base}?sslmode=disable&sslmode=verify-full`, /repeats the query parameter "sslmode"/],
    ['an unknown sslmode', `${base}?sslmode=maybe`, /unrecognised sslmode/],
    ['target_session_attrs other than any', `${base}?target_session_attrs=read-write`, /silently ignored/],
    ['a non-numeric connect_timeout', `${base}?connect_timeout=soon`, /non-numeric connect_timeout/],
    ['a Unix socket host', `postgres://secretuser:${SECRET}@%2Fvar%2Frun%2Fpostgresql/rab`, /Unix socket/],
    ['no database', `postgres://secretuser:${SECRET}@localhost:5432/`, /must name a database/],
    ['no user', `postgres://localhost:5432/rab`, /must name a user/],
    ['a non-postgres scheme', `mysql://secretuser:${SECRET}@localhost/rab`, /must be a postgres:\/\//],
    ['an unparseable string', `postgres://secretuser:${SECRET}@local host:99999/rab`, /not a parseable|invalid port/],
  ])('refuses %s', (_name, url, pattern) => {
    let caught: unknown;
    try {
      parsePgUrl(url, 'PG_DATABASE_URL');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PgConfigError);
    const message = (caught as Error).message;
    expect(message).toMatch(pattern);
    expect(message).toMatch(/^PG_DATABASE_URL /);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('secretuser');
    expect(message).not.toMatch(/evil\.example|10\.0\.0\.9|\/tmp\//);
  });

  it('redactPgUrl keeps only scheme, host, port and database', () => {
    expect(redactPgUrl(`postgres://secretuser:${SECRET}@db.example.com:25060/defaultdb?sslmode=require`)).toBe(
      'postgres://<redacted>@db.example.com:25060/defaultdb',
    );
    expect(redactPgUrl(`not a url ${SECRET}`)).toBe('<unparseable postgres url>');
  });
});

describe('pg-url-policy: security review N-1 (trailing-dot host, Neon password routing)', () => {
  const PROD_HOST = 'ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech';

  it('strips ONE trailing dot off the host before any host rule, so the Neon endpoint key is the same', () => {
    const target = parsePgUrl(`postgres://crewflow_app:${SECRET}@${PROD_HOST}./neondb?sslmode=verify-full`, 'PG_DATABASE_URL');
    expect(target.host).toBe(PROD_HOST);
    expect(describePgTarget(target).endpointKey).toBe('neon:ep-round-rain-aess0njf');
    const pooled = parsePgUrl(`postgres://crewflow_app:${SECRET}@EP-ROUND-RAIN-AESS0NJF-POOLER.c-2.us-east-2.aws.neon.tech./neondb`, 'PG_DATABASE_URL');
    expect(describePgTarget(pooled).endpointKey).toBe('neon:ep-round-rain-aess0njf');
    expect(parsePgUrl(`postgres://u:${SECRET}@localhost./rab`, 'PG_DATABASE_URL').host).toBe('localhost');
  });

  it('accepts Neon password routing only on a Neon host naming that host\'s own endpoint, and records the routed endpoint', () => {
    for (const sep of ['%24', ';']) {
      const target = parsePgUrl(`postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf${sep}${SECRET}@${PROD_HOST}/neondb`, 'PG_DATABASE_URL');
      expect(target.routedNeonEndpoint).toBe('ep-round-rain-aess0njf');
      expect(target.password).toBe(`endpoint=ep-round-rain-aess0njf${decodeURIComponent(sep)}${SECRET}`);
      expect(JSON.stringify(target)).not.toContain(SECRET);
    }
    // An ordinary password routes nowhere; the options token records the (identical) host endpoint.
    expect(parsePgUrl(`postgres://u:${SECRET}@${PROD_HOST}/neondb`, 'PG_DATABASE_URL').routedNeonEndpoint).toBeNull();
    expect(parsePgUrl(`postgres://u:${SECRET}@${PROD_HOST}/neondb?options=endpoint%3Dep-round-rain-aess0njf`, 'PG_DATABASE_URL').routedNeonEndpoint).toBe(
      'ep-round-rain-aess0njf',
    );
  });

  it.each([
    ['a non-loopback IP host', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@10.0.0.5/neondb`],
    ['a loopback tunnel', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@127.0.0.1:15432/neondb`],
    ['an alias / CNAME host', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@db.example.com/neondb`],
    ['a docker-service host', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%3B${SECRET}@devdb/neondb`],
    ['a Neon host of ANOTHER endpoint', `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@ep-other-1.eu-west-2.aws.neon.tech/neondb`],
    ['an upper-case prefix', `postgres://crewflow_app:ENDPOINT%3Dep-round-rain-aess0njf%24${SECRET}@10.0.0.5/neondb`],
    ['a malformed endpoint id', `postgres://crewflow_app:endpoint%3D%21bad%24${SECRET}@${PROD_HOST}/neondb`],
  ])('refuses Neon password routing on %s, never echoing the password', (_name, url) => {
    let caught: unknown;
    try {
      parsePgUrl(url, 'PG_DATABASE_URL');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PgConfigError);
    const message = (caught as Error).message;
    expect(message).toMatch(/^PG_DATABASE_URL carries Neon password routing .*Refusing \(password not shown\)\.$/);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('ep-round-rain');
  });

  it('refuses a host still ending in a dot after one is stripped', () => {
    expect(() => parsePgUrl(`postgres://u:${SECRET}@db.example.com../rab`, 'PG_DATABASE_URL')).toThrow(PgConfigError);
  });
});
