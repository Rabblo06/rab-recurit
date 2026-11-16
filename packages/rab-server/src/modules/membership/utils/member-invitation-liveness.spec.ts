import { EntityManager } from 'typeorm';

import { memberInvitationExpiredSql, memberInvitationParentFailure, memberInvitationStateFailure } from './member-invitation-liveness';

/**
 * Unit cover for the shared member-invitation liveness rule (S-W1). The database behaviour (RLS visibility, the Worker
 * cancelling the outbox row) is covered by rab-worker's member-invitation-delivery integration spec; this pins the
 * decision table both callers now share.
 */
describe('member-invitation liveness (shared by API acceptance and Worker pre-send)', () => {
  const live = { accepted_at: null, revoked_at: null, superseded_at: null, is_expired: false };

  it('state: a pending, unexpired invitation is live', () => {
    expect(memberInvitationStateFailure(live)).toBeNull();
  });

  it.each([
    [{ accepted_at: new Date() }, 'accepted'],
    [{ revoked_at: new Date() }, 'revoked'],
    [{ superseded_at: new Date() }, 'superseded'],
    [{ is_expired: true }, 'expired'],
  ] as const)('state: %o is not live (%s)', (patch, expected) => {
    expect(memberInvitationStateFailure({ ...live, ...patch })).toBe(expected);
  });

  it('state: a row whose expiry was not computed is never live by omission (fail closed)', () => {
    expect(memberInvitationStateFailure({ accepted_at: null, revoked_at: null, superseded_at: null })).toBe('expired');
    expect(memberInvitationStateFailure({ ...live, is_expired: null })).toBe('expired');
  });

  it('expiry is decided in SQL with database time, inclusive at the boundary', () => {
    expect(memberInvitationExpiredSql()).toBe('(expires_at <= now())');
    expect(memberInvitationExpiredSql('i')).toBe('(i.expires_at <= now())');
    expect(memberInvitationExpiredSql('mi_2')).toBe('(mi_2.expires_at <= now())');
  });

  it.each(['', 'I', '1i', 'i.x', 'i ', 'i; DROP TABLE core.member_invitation; --', '"i"', "i'", 'i)--'])(
    'expiry: an alias that is not a plain identifier (%p) throws instead of reaching SQL',
    (alias) => {
      expect(() => memberInvitationExpiredSql(alias)).toThrow(/plain SQL identifier/);
    },
  );

  /** A manager answering the two parent lookups from fixed rows (`undefined` = row not visible / missing). */
  function managerWith(org: { suspended_at: Date | null } | undefined, ws: { status: string } | undefined): EntityManager {
    return {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('core.organisation')) return org ? [org] : [];
        if (sql.includes('core.manager_workspace')) return ws ? [ws] : [];
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as EntityManager;
  }

  it('parents: an active organisation and an active workspace are live', async () => {
    await expect(memberInvitationParentFailure(managerWith({ suspended_at: null }, { status: 'active' }), 'org', 'ws')).resolves.toBeNull();
  });

  it.each(['suspended', 'archived', ''])('parents (S-W1): a workspace with status %p is not live', async (status) => {
    await expect(memberInvitationParentFailure(managerWith({ suspended_at: null }, { status }), 'org', 'ws')).resolves.toBe('workspace_inactive');
  });

  it('parents: a workspace that cannot be seen (missing or hidden by RLS) fails closed', async () => {
    await expect(memberInvitationParentFailure(managerWith({ suspended_at: null }, undefined), 'org', 'ws')).resolves.toBe('workspace_inactive');
  });

  it('parents: no workspace id at all fails closed without a lookup', async () => {
    const manager = managerWith({ suspended_at: null }, { status: 'active' });
    await expect(memberInvitationParentFailure(manager, 'org', null)).resolves.toBe('workspace_inactive');
    expect((manager.query as jest.Mock).mock.calls.some(([sql]) => String(sql).includes('manager_workspace'))).toBe(false);
  });

  it('parents: a suspended or invisible organisation is not live (checked before the workspace)', async () => {
    await expect(memberInvitationParentFailure(managerWith({ suspended_at: new Date() }, { status: 'active' }), 'org', 'ws')).resolves.toBe('organisation_suspended');
    await expect(memberInvitationParentFailure(managerWith(undefined, { status: 'active' }), 'org', 'ws')).resolves.toBe('organisation_suspended');
  });
});
