import { EmailOutboxJobType, PasswordResetTokenPurpose, UserStatus } from '@rab/shared';

import { EmailOutboxService } from '../../email/email-outbox.service';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AuthService } from './auth.service';

/**
 * Soak review defect (a): seven account/auth emails fast-published their outbox row from INSIDE the transaction that wrote
 * it, so the Worker could run the job before COMMIT and spend a BullMQ retry on "not visible yet". Each of the seven sites
 * must now publish only AFTER that transaction commits, and publish nothing when it rolls back:
 *
 *   AccountLifecycleService  1 sendAccountInvite   2 adminResetPassword   3 sendSuspensionNotice
 *   AuthService              4 first-login WELCOME 5 forgotPassword       6 INITIAL_SETUP reset WELCOME
 *                            7 PASSWORD_UPDATED (sendPasswordUpdatedEmail, from setPassword and resetPassword)
 *
 * The transaction here is a faithful stand-in for TypeORM's: an `isTransactionActive` QueryRunner shared by the manager,
 * COMMIT clears it and then broadcasts AfterTransactionCommit to `connection.subscribers`; a failure (in the body or at
 * COMMIT) broadcasts AfterTransactionRollback instead. Every publish records whether a transaction was still open.
 */
type Sub = {
  afterTransactionCommit: (e: { queryRunner: unknown }) => unknown;
  afterTransactionRollback: (e: { queryRunner: unknown }) => unknown;
};

const ORG = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';
const STRONG_PASSWORD = 'Vq8#Lr2!Xz7@Pm4$';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function chain(result: { rows?: unknown[]; affected?: number }) {
  const qb: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'where', 'select', 'update', 'set', 'andWhere']) qb[m] = () => qb;
  qb.getRawMany = async () => result.rows ?? [{ key: 'staff' }];
  qb.execute = async () => ({ affected: result.affected ?? 1 });
  return qb;
}

function harness(opts: { user?: Record<string, unknown> } = {}) {
  const subscribers: Sub[] = [];
  const runner = { isReleased: false, isTransactionActive: false };
  const user = { id: USER, organisationId: ORG, email: 'person@example.test', firstName: 'Pat', mustResetPassword: true, status: UserStatus.ACTIVE, ...opts.user };
  let seq = 0;
  const enqueued: Array<{ id: string; jobType: string }> = [];
  const manager = {
    queryRunner: runner,
    connection: { subscribers },
    query: jest.fn(async (sql: string) => (sql.includes('suspended_at') ? [{ suspended_at: null }] : sql.includes('user_role') ? [{ key: 'staff' }] : [])),
    update: jest.fn(async () => ({ affected: 1 })),
    create: jest.fn((_entity: unknown, values: Record<string, unknown>) => ({ ...values })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      const saved = { ...row, id: `outbox-${++seq}` } as { id: string; jobType: string };
      enqueued.push(saved);
      return saved;
    }),
    findOneOrFail: jest.fn(async () => user),
    findOneByOrFail: jest.fn(async () => ({ id: ORG, name: 'Acme' })),
    createQueryBuilder: jest.fn(() => chain({})),
  };
  const state = { failCommit: false, commits: 0, rollbacks: 0 };
  /** TypeORM's `dataSource.transaction`, as `runInTenantContext` uses it. */
  const transaction = async <T>(fn: (m: never) => Promise<T>): Promise<T> => {
    runner.isTransactionActive = true;
    const rowsBefore = enqueued.length;
    let result: T;
    try {
      result = await fn(manager as never);
      // Only the transaction that wrote an outbox row fails at COMMIT (the read-only role lookups before it commit normally).
      if (state.failCommit && enqueued.length > rowsBefore) throw new Error('could not serialize access (COMMIT failed)');
    } catch (error) {
      runner.isTransactionActive = false;
      state.rollbacks++;
      subscribers.forEach((s) => s.afterTransactionRollback({ queryRunner: runner }));
      throw error;
    }
    runner.isTransactionActive = false;
    state.commits++;
    subscribers.forEach((s) => s.afterTransactionCommit({ queryRunner: runner }));
    return result;
  };
  const published: Array<{ id: string; organisationId: string; inTransaction: boolean }> = [];
  const emailQueue = {
    publish: jest.fn(async (id: string, organisationId: string) => {
      published.push({ id, organisationId, inTransaction: runner.isTransactionActive });
    }),
  };
  const emailOutbox = new EmailOutboxService();
  const env = { get: jest.fn((key: string) => (key === 'ACCOUNTS_URL' ? 'https://accounts.example.test' : key === 'APP_URL' ? 'https://app.example.test' : undefined)) };
  const audit = { record: jest.fn(async () => undefined) };
  const refreshTokens = {
    revokeAllForUser: jest.fn(async () => undefined),
    issue: jest.fn(async () => ({ token: 'refresh', expiresAt: new Date(Date.now() + 60_000), familyExpiresAt: new Date(Date.now() + 60_000), webSessionToken: undefined })),
  };
  const securityVersion = { bumpUser: jest.fn(async () => undefined) };
  const resetTokens = {
    issue: jest.fn(async () => ({ id: 'reset-token-id', token: 'reset-token' })),
    hashToken: jest.fn(() => 'reset-token-hash'),
    consume: jest.fn(async () => ({ userId: USER, purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD as string, applicationTarget: 'staff_app' })),
  };
  const lifecycle = new AccountLifecycleService(
    resetTokens as never,
    {
      prepare: jest.fn(async () => ({ token: 'invite-token', tokenHash: 'h', sendNumber: 1, expiresAt: new Date(Date.now() + 60_000), cleanupAt: new Date(Date.now() + 120_000) })),
      commit: jest.fn(async () => ({ id: 'invite-id' })),
    } as never,
    refreshTokens as never,
    emailOutbox,
    emailQueue as never,
    audit as never,
    env as never,
    securityVersion as never,
  );
  const dataSource = { query: jest.fn(async (): Promise<unknown[]> => []) };
  const platformAdmin = { isPlatformAdmin: jest.fn(async () => false), isPlatformAdminTx: jest.fn(async () => false) };
  const auth = new AuthService(
    dataSource as never,
    { runInTenantContext: jest.fn((_ctx: unknown, fn: (m: never) => Promise<unknown>) => transaction(fn)) } as never,
    { hash: jest.fn(async () => 'argon2id-hash') } as never,
    { sign: jest.fn(() => 'access-jwt') } as never,
    refreshTokens as never,
    resetTokens as never,
    emailOutbox,
    emailQueue as never,
    audit as never,
    env as never,
    platformAdmin as never,
    { resolveForUser: jest.fn(async () => 'workspace-1') } as never,
    undefined as never,
    undefined as never,
    { systemEnabled: () => ({ password: true }), getEffective: async () => ({ password: true }) } as never,
    securityVersion as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { recordSignInGrant: jest.fn(async () => undefined) } as never,
  );
  const ctx = { organisationId: ORG, workspaceId: null, userId: 'actor-user', role: '' } as never;
  return { lifecycle, auth, transaction, manager, state, published, enqueued, emailQueue, dataSource, platformAdmin, resetTokens, ctx, user };
}

type H = ReturnType<typeof harness>;

/** The seven sites, each driven through its real public (or, for the login convergence point, real private) entry. */
const SITES: Array<{ name: string; jobType: string; run: (h: H) => Promise<unknown>; setup?: (h: H) => void }> = [
  {
    name: '1 AccountLifecycleService.sendAccountInvite (ACCOUNT_INVITATION)',
    jobType: EmailOutboxJobType.ACCOUNT_INVITATION,
    run: (h) => h.transaction((m) => h.lifecycle.sendAccountInvite(m, h.ctx, { userId: USER, email: 'person@example.test', createdBy: 'actor-user' })),
  },
  {
    name: '2 AccountLifecycleService.adminResetPassword (PASSWORD_RESET)',
    jobType: EmailOutboxJobType.PASSWORD_RESET,
    run: (h) => h.transaction((m) => h.lifecycle.adminResetPassword(m, h.ctx, { targetUserId: USER, targetEmail: 'person@example.test', targetFirstName: 'Pat', organisationName: 'Acme' })),
  },
  {
    name: '3 AccountLifecycleService.sendSuspensionNotice (ACCOUNT_SUSPENDED)',
    jobType: EmailOutboxJobType.ACCOUNT_SUSPENDED,
    run: (h) => h.transaction((m) => h.lifecycle.sendSuspensionNotice(m, h.ctx, { userId: USER, email: 'person@example.test', firstName: 'Pat', organisationName: 'Acme' })),
  },
  {
    name: '4 AuthService.completeLogin first-login WELCOME',
    jobType: EmailOutboxJobType.WELCOME,
    setup: (h) => {
      h.platformAdmin.isPlatformAdmin.mockResolvedValue(true);
    },
    run: (h) =>
      (h.auth as unknown as { completeLogin: (...a: unknown[]) => Promise<unknown> }).completeLogin(
        { ...h.user, status: UserStatus.INVITED },
        {},
        false,
        undefined,
        'google',
        { secondFactorVerified: true },
      ),
  },
  {
    name: '5 AuthService.forgotPassword (PASSWORD_RESET)',
    jobType: EmailOutboxJobType.PASSWORD_RESET,
    setup: (h) => {
      h.dataSource.query.mockResolvedValue([{ ...h.user, passwordHash: 'x', status: UserStatus.ACTIVE }]);
    },
    run: (h) => h.auth.forgotPassword({ email: 'person@example.test' }),
  },
  {
    name: '6 AuthService.resetPassword INITIAL_SETUP WELCOME',
    jobType: EmailOutboxJobType.WELCOME,
    setup: (h) => {
      h.dataSource.query.mockResolvedValue([{ organisationId: ORG, userId: USER }]);
      h.resetTokens.consume.mockResolvedValue({ userId: USER, purpose: PasswordResetTokenPurpose.INITIAL_SETUP, applicationTarget: 'staff_app' });
    },
    run: (h) => h.auth.resetPassword({ token: 'reset-token', newPassword: STRONG_PASSWORD }),
  },
  {
    name: '7a AuthService.setPassword → sendPasswordUpdatedEmail (PASSWORD_UPDATED)',
    jobType: EmailOutboxJobType.PASSWORD_UPDATED,
    run: (h) => h.auth.setPassword({ organisationId: ORG, workspaceId: null, userId: USER, role: '' } as never, STRONG_PASSWORD),
  },
  {
    name: '7b AuthService.resetPassword (forgot-password token) → sendPasswordUpdatedEmail (PASSWORD_UPDATED)',
    jobType: EmailOutboxJobType.PASSWORD_UPDATED,
    setup: (h) => {
      h.dataSource.query.mockResolvedValue([{ organisationId: ORG, userId: USER }]);
    },
    run: (h) => h.auth.resetPassword({ token: 'reset-token', newPassword: STRONG_PASSWORD }),
  },
];

describe('account and auth emails publish only after their transaction commits', () => {
  describe.each(SITES)('$name', (site) => {
    it('writes the row in the transaction, publishes nothing before COMMIT, then exactly one publish of that row after it', async () => {
      const h = harness();
      site.setup?.(h);
      await site.run(h);
      await flush();
      const row = h.enqueued.find((r) => r.jobType === site.jobType);
      expect(row).toBeDefined();
      expect(h.published).toEqual([{ id: row!.id, organisationId: ORG, inTransaction: false }]);
    });

    it('a rollback (here: COMMIT itself fails) publishes nothing', async () => {
      const h = harness();
      site.setup?.(h);
      h.state.failCommit = true;
      await expect(site.run(h)).rejects.toThrow();
      await flush();
      expect(h.enqueued.some((r) => r.jobType === site.jobType)).toBe(true);
      expect(h.state.rollbacks).toBeGreaterThan(0);
      expect(h.emailQueue.publish).not.toHaveBeenCalled();
    });
  });

  it('a publish registered in a still-open transaction waits however long the transaction stays open', async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const done = h.transaction(async (m) => {
      await h.lifecycle.sendAccountInvite(m, h.ctx, { userId: USER, email: 'person@example.test', createdBy: 'actor-user' });
      await held;
    });
    for (let i = 0; i < 5; i++) await flush();
    expect(h.emailQueue.publish).not.toHaveBeenCalled();
    release();
    await done;
    await flush();
    expect(h.emailQueue.publish).toHaveBeenCalledTimes(1);
  });
});

describe('forgot-password stays uniform (abuse case: account discovery)', () => {
  const FLOOR_MS = 150;
  const timed = async (fn: () => Promise<unknown>) => {
    const started = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - started };
  };

  it('a nonexistent email runs the same entry, publishes nothing, writes nothing, and answers like an existing account', async () => {
    const missing = harness();
    missing.dataSource.query.mockResolvedValue([]);
    const absent = await timed(() => missing.auth.forgotPassword({ email: 'nobody@example.test' }));
    await flush();
    expect(missing.emailQueue.publish).not.toHaveBeenCalled();
    expect(missing.enqueued).toEqual([]);
    expect(missing.state.commits + missing.state.rollbacks).toBe(0);

    const existing = harness();
    existing.dataSource.query.mockResolvedValue([{ ...existing.user, passwordHash: 'x', status: UserStatus.ACTIVE }]);
    const present = await timed(() => existing.auth.forgotPassword({ email: 'person@example.test' }));
    await flush();
    expect(existing.emailQueue.publish).toHaveBeenCalledTimes(1);

    // Same response (nothing), same timing class: both padded to the floor; the publish adds no wait to either.
    expect(absent.value).toBeUndefined();
    expect(present.value).toBeUndefined();
    expect(absent.ms).toBeGreaterThanOrEqual(FLOOR_MS - 2);
    expect(present.ms).toBeGreaterThanOrEqual(FLOOR_MS - 2);
    expect(absent.ms).toBeLessThan(FLOOR_MS + 400);
    expect(present.ms).toBeLessThan(FLOOR_MS + 400);
  });

  it('an existing account whose publish hangs forever (Redis stalled) still answers at the floor: the publish is detached', async () => {
    const h = harness();
    h.dataSource.query.mockResolvedValue([{ ...h.user, passwordHash: 'x', status: UserStatus.ACTIVE }]);
    h.emailQueue.publish.mockImplementation(() => new Promise<void>(() => undefined));
    const { value, ms } = await timed(() => h.auth.forgotPassword({ email: 'person@example.test' }));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(FLOOR_MS + 400);
    expect(h.emailQueue.publish).toHaveBeenCalledTimes(1);
  });

  it('an inactive (e.g. INVITED) account behaves exactly like a nonexistent one: no row, no publish, same response', async () => {
    const h = harness();
    h.dataSource.query.mockResolvedValue([{ ...h.user, passwordHash: null, status: UserStatus.INVITED }]);
    const { value, ms } = await timed(() => h.auth.forgotPassword({ email: 'person@example.test' }));
    await flush();
    expect(value).toBeUndefined();
    expect(ms).toBeGreaterThanOrEqual(FLOOR_MS - 2);
    expect(h.enqueued).toEqual([]);
    expect(h.emailQueue.publish).not.toHaveBeenCalled();
  });
});
