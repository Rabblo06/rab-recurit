import { companyLabelFromEmail, SubdomainService } from './subdomain.service';

/** A DataSource stub answering `core.workspace_subdomain_taken` for a batch, recording every round trip. */
function fakeDataSource(taken: Set<string>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const labels = params[0] as string[];
      return labels.map((label) => ({ label, taken: taken.has(label) }));
    }),
  };
  return { dataSource, calls };
}

describe('companyLabelFromEmail', () => {
  it.each([
    ['jo@acme.com', 'acme'],
    ['jo@mail.acme.co.uk', 'acme'],
    ['jo@Acme.IO', 'acme'],
    ['jo@gmail.com', null],
    ['jo@hotmail.co.uk', null],
    ['jo@proton.me', null],
    ['jo@localhost', null],
    ['not-an-email', null],
    [null, null],
  ])('%s → %s', (email, expected) => {
    expect(companyLabelFromEmail(email)).toBe(expected);
  });
});

describe('SubdomainService', () => {
  it('checkAvailability: an available label costs exactly ONE query', async () => {
    const { dataSource, calls } = fakeDataSource(new Set());
    const result = await new SubdomainService(dataSource as never).checkAvailability('Acme Events');
    expect(result).toEqual({ available: true, normalized: 'acme-events', reserved: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('unnest');
  });

  it('checkAvailability: a taken label returns numbered alternatives from the same single query', async () => {
    const { dataSource, calls } = fakeDataSource(new Set(['acme', 'acme01']));
    const result = await new SubdomainService(dataSource as never).checkAvailability('acme', 'own-ws');
    expect(result.available).toBe(false);
    expect(result.suggested).toBe('acme02');
    expect(result.alternatives).toEqual(['acme03', 'acme04']);
    expect(calls).toHaveLength(1);
    // The caller's own workspace is excluded (its own label / own quarantined labels read available).
    expect(calls[0]!.params[1]).toBe('own-ws');
  });

  it('checkAvailability: reserved labels (list and prefixes) are refused without a query and get no suggestion', async () => {
    const { dataSource, calls } = fakeDataSource(new Set());
    const service = new SubdomainService(dataSource as never);
    for (const label of ['admin', 'accounts', 'api-eu', 'www-old']) {
      expect(await service.checkAvailability(label)).toEqual({ available: false, normalized: label, reserved: true });
    }
    expect(calls).toHaveLength(0);
    // Normalisation collapses repeated hyphens, so a punycode (`xn--`) label can never even be requested.
    expect((await service.checkAvailability('xn--pple-43d')).normalized).toBe('xn-pple-43d');
  });

  it('suggest: email domain (non-free), workspace name, organisation name — up to 3, checked in ONE query', async () => {
    const { dataSource, calls } = fakeDataSource(new Set(['acme']));
    const suggestions = await new SubdomainService(dataSource as never).suggest({ email: 'jo@acme.co.uk', workspaceName: 'Night Crew', organisationName: 'Acme Holdings' });
    expect(suggestions).toEqual(['acme01', 'acme02', 'acme03']);
    expect(calls).toHaveLength(1);
    const checked = calls[0]!.params[0] as string[];
    expect(checked).toEqual(expect.arrayContaining(['acme', 'night-crew', 'acme-holdings']));
  });

  it('suggest: a free-provider email never seeds a suggestion; reserved names never appear', async () => {
    const { dataSource, calls } = fakeDataSource(new Set());
    const suggestions = await new SubdomainService(dataSource as never).suggest({ email: 'jo@gmail.com', workspaceName: 'Admin', organisationName: 'Bravo Bar' });
    expect(suggestions[0]).toBe('bravo-bar');
    const checked = calls[0]!.params[0] as string[];
    expect(checked.some((label) => label.startsWith('gmail'))).toBe(false);
    expect(checked).not.toContain('admin');
  });
});
