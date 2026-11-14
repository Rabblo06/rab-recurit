import { NotFoundException } from '@nestjs/common';

import { assertUsersOfOrganisationTx } from './core-references';

/** Part D 0a (DRAFT): the service-layer reference check that replaces the dropped workspace → core."user" foreign keys. */
describe('assertUsersOfOrganisationTx', () => {
  const fake = (n: number) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return { calls, manager: { query: async (sql: string, params: unknown[]) => (calls.push({ sql, params }), [{ n }]) } };
  };

  it('passes when every distinct id is a user of the organisation (one bound query, organisation-scoped)', async () => {
    const f = fake(2);
    await expect(assertUsersOfOrganisationTx(f.manager as never, 'org-1', ['u1', 'u2', 'u1', null, undefined])).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.sql).toMatch(/u\.organisation_id = \$2/);
    expect(f.calls[0]!.params).toEqual([['u1', 'u2'], 'org-1']);
  });

  it('404 when one id is missing or of another organisation (never a 403 that confirms it exists)', async () => {
    await expect(assertUsersOfOrganisationTx(fake(1).manager as never, 'org-1', ['u1', 'u2'])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('no id: nothing read; no organisation bound: denied', async () => {
    const f = fake(0);
    await expect(assertUsersOfOrganisationTx(f.manager as never, 'org-1', [null])).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(0);
    await expect(assertUsersOfOrganisationTx(f.manager as never, '', ['u1'])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a query that throws propagates (fail closed)', async () => {
    const boom = { query: async () => { throw new Error('permission denied'); } };
    await expect(assertUsersOfOrganisationTx(boom as never, 'org-1', ['u1'])).rejects.toThrow('permission denied');
  });
});
