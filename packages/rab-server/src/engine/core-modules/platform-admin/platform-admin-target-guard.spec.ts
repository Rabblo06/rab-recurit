import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { assertPlatformAdminTargetAllowed } from './platform-admin-target-guard';

/** Security review of #264, F2: the tenant side never acts on (or learns about) a platform admin's account. */
describe('assertPlatformAdminTargetAllowed', () => {
  const managerAnswering = (row: { target: boolean; actor: boolean } | undefined) =>
    ({ query: jest.fn().mockResolvedValue(row ? [row] : []) }) as unknown as EntityManager & { query: jest.Mock };

  it('an ordinary target: allowed for anyone', async () => {
    await expect(assertPlatformAdminTargetAllowed(managerAnswering({ target: false, actor: false }), 'actor', 'target', 'Manager not found.')).resolves.toBeUndefined();
  });

  it('DENIAL: a platform-admin target and a tenant actor -> 404 with the caller\'s own not-found text (never a 403)', async () => {
    await expect(assertPlatformAdminTargetAllowed(managerAnswering({ target: true, actor: false }), 'actor', 'target', 'Manager not found.')).rejects.toEqual(
      new NotFoundException('Manager not found.'),
    );
  });

  it('a platform-admin actor keeps its own paths (Admin Panel resend)', async () => {
    await expect(assertPlatformAdminTargetAllowed(managerAnswering({ target: true, actor: true }), 'actor', 'target', 'x')).resolves.toBeUndefined();
  });

  it('fail closed: no answer is a 404; a missing actor id is never an admin', async () => {
    await expect(assertPlatformAdminTargetAllowed(managerAnswering(undefined), 'actor', 'target', 'Staff member not found.')).rejects.toBeInstanceOf(NotFoundException);
    const m = managerAnswering({ target: false, actor: false });
    await assertPlatformAdminTargetAllowed(m, undefined, 'target', 'x');
    expect(m.query.mock.calls[0]![1]).toEqual(['target', null]);
  });
});
