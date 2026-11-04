import {
  AuditSinkConfigError,
  AuditSinkError,
  createSecurityAuditSink,
  formatSecurityAuditEvent,
  securityAuditSinkConfig,
} from './security-audit-sink';

const ORG = '11111111-2222-4333-8444-555555555555';

describe('security audit sink: configuration (fail closed)', () => {
  it('development defaults to none / log; stdout and file are accepted', () => {
    expect(securityAuditSinkConfig({})).toEqual({ mode: 'none', file: null, failure: 'log', production: false });
    expect(securityAuditSinkConfig({ CREWFLOW_AUDIT_SINK: 'stdout' })).toMatchObject({ mode: 'stdout', failure: 'log' });
    expect(securityAuditSinkConfig({ CREWFLOW_AUDIT_SINK: 'file', CREWFLOW_AUDIT_SINK_FILE: '/var/log/crewflow/audit.jsonl' })).toMatchObject({ mode: 'file' });
  });

  it('production REQUIRES a sink (owner login: audit_log alone is not tamper-evident) and defaults to refuse', () => {
    for (const env of [{ NODE_ENV: 'production' }, { RAB_RUNTIME_ENV: 'production' }, { NODE_ENV: 'production', CREWFLOW_AUDIT_SINK: 'none' }]) {
      expect(() => securityAuditSinkConfig(env)).toThrow(/production requires an external security audit sink/);
    }
    expect(securityAuditSinkConfig({ NODE_ENV: 'production', CREWFLOW_AUDIT_SINK: 'stdout' })).toEqual({ mode: 'stdout', file: null, failure: 'refuse', production: true });
    expect(() => securityAuditSinkConfig({ NODE_ENV: 'production', CREWFLOW_AUDIT_SINK: 'stdout', CREWFLOW_AUDIT_SINK_FAILURE: 'log' })).toThrow(/requires CREWFLOW_AUDIT_SINK_FAILURE=refuse/);
    expect(() => securityAuditSinkConfig({ NODE_ENV: 'production', CREWFLOW_AUDIT_SINK: 'file', CREWFLOW_AUDIT_SINK_FILE: '/x' })).toThrow(/development only/);
  });

  it.each([
    [{ CREWFLOW_AUDIT_SINK: 'syslog' }, /exactly none, stdout or file/],
    [{ CREWFLOW_AUDIT_SINK: 'STDOUT' }, /exactly none, stdout or file/],
    [{ CREWFLOW_AUDIT_SINK: 'file' }, /needs CREWFLOW_AUDIT_SINK_FILE, an absolute path/],
    [{ CREWFLOW_AUDIT_SINK: 'file', CREWFLOW_AUDIT_SINK_FILE: 'relative/audit.log' }, /absolute path/],
    [{ CREWFLOW_AUDIT_SINK_FILE: '/tmp/a' }, /is not file/],
    [{ CREWFLOW_AUDIT_SINK_FAILURE: 'ignore' }, /exactly refuse or log/],
  ])('refuses %p', (env, pattern) => {
    expect(() => securityAuditSinkConfig(env)).toThrow(AuditSinkConfigError);
    expect(() => securityAuditSinkConfig(env)).toThrow(pattern);
  });
});

describe('security audit sink: structured, redacted events', () => {
  it('redacts secret-looking keys, masks e-mail addresses and URLs, keeps only uuid identifiers', () => {
    const line = formatSecurityAuditEvent(
      {
        type: 'auth.login.failed',
        severity: 'warning',
        process: 'api',
        organisationId: ORG,
        actorUserId: 'alice@example.com',
        detail: {
          email: 'alice@example.com',
          password: 'hunter2',
          passwordHash: '$argon2id$...',
          totp_secret: 'x',
          refreshToken: 'y',
          nested: { Authorization: 'Bearer z', note: 'see postgres://u:p@h/db' },
          attempts: 3,
        },
      },
      new Date('2026-11-04T00:00:00Z'),
    );
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ v: 1, at: '2026-11-04T00:00:00.000Z', type: 'auth.login.failed', organisationId: ORG, actorUserId: null });
    expect(parsed.detail).toEqual({
      email: 'a***@example.com',
      password: '[REDACTED]',
      passwordHash: '[REDACTED]',
      totp_secret: '[REDACTED]',
      refreshToken: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', note: 'see [url]' },
      attempts: 3,
    });
    expect(line).not.toMatch(/hunter2|argon2id|Bearer|alice@/);
  });

  it('bounds the event (string length, depth, key count) and refuses a malformed type', () => {
    const big = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]));
    const parsed = JSON.parse(formatSecurityAuditEvent({ type: 'a.b', severity: 'info', process: 'p', detail: { ...big, deep: { a: { b: { c: { d: 1 } } } } } }));
    expect(Object.keys(parsed.detail).length).toBeLessThanOrEqual(50);
    expect(String(parsed.detail.k0).length).toBe(256);
    expect(() => formatSecurityAuditEvent({ type: 'Bad Type', severity: 'info', process: 'p' })).toThrow(AuditSinkError);
  });
});

describe('security audit sink: adapters and failure behaviour', () => {
  const event = { type: 'security.posture.drift', severity: 'critical' as const, process: 'api' };

  it('stdout writes one prefixed JSON line per event', async () => {
    const lines: string[] = [];
    const sink = createSecurityAuditSink({ mode: 'stdout', file: null, failure: 'refuse', production: true }, { stdout: async (l) => void lines.push(l) });
    await sink.emit(event);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^CREWFLOW_SECURITY_AUDIT \{"v":1,/);
  });

  it('file appends to the configured absolute path', async () => {
    const writes: Array<[string, string]> = [];
    const sink = createSecurityAuditSink({ mode: 'file', file: '/var/log/a.jsonl', failure: 'log', production: false }, { appendFile: async (p, l) => void writes.push([p, l]) });
    await sink.emit(event);
    expect(writes[0]![0]).toBe('/var/log/a.jsonl');
    expect(JSON.parse(writes[0]![1]).type).toBe('security.posture.drift');
  });

  it('refuse: a failed write throws AuditSinkError (the caller fails closed); log: it is logged and the caller continues', async () => {
    const failing = async () => Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const refuse = createSecurityAuditSink({ mode: 'stdout', file: null, failure: 'refuse', production: true }, { stdout: failing });
    await expect(refuse.emit(event)).rejects.toThrow(/could not record security\.posture\.drift \(code ENOSPC\)/);
    const logs: string[] = [];
    const lenient = createSecurityAuditSink({ mode: 'stdout', file: null, failure: 'log', production: false }, { stdout: failing, log: (l) => void logs.push(l) });
    await expect(lenient.emit(event)).resolves.toBeUndefined();
    expect(logs[0]).toMatch(/could not record security\.posture\.drift \(code ENOSPC\); continuing/);
  });

  it('none records nothing but still validates the event shape', async () => {
    const sink = createSecurityAuditSink({ mode: 'none', file: null, failure: 'log', production: false });
    await expect(sink.emit(event)).resolves.toBeUndefined();
    await expect(sink.emit({ ...event, type: 'NOPE' })).rejects.toThrow(AuditSinkError);
  });
});
