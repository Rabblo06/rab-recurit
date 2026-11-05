import { ConflictException } from '@nestjs/common';

import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';
import { isRaceLoserError, ManagerWorkspaceService, WORKSPACE_CREATE_LOCK_NAMESPACE } from './manager-workspace.service';

/**
 * Concurrent identical creates (CI: three POSTs for one owner on two API replicas → [201, 201, 500] with 40P01 "deadlock
 * detected" on the INSERT INTO core.manager_workspace). Two-part fix, idempotent-create semantics unchanged:
 *   1. createFor takes a per-owner transaction-scoped advisory lock BEFORE any read that decides and any write;
 *   2. create() treats 40P01 / 40001 like a lost unique race: replay if the winner's workspace exists, else rethrow.
 */
const CTX = { organisationId: '00000000-0000-4000-8000-0000000000aa', workspaceId: null, userId: '00000000-0000-4000-8000-0000000000bb', role: 'manager' };
const DTO = { name: 'Acme', subdomain: 'acme' };
const REPLAY = { id: 'workspace-1', organisationId: CTX.organisationId, ownerUserId: CTX.userId, name: 'Acme', subdomain: 'acme', status: 'active', schemaStatus: 'READY' };

function harness(opts: { createForError?: unknown; replay?: boolean } = {}) {
  const statements: string[] = [];
  let createForCalls = 0;
  let findReplayCalls = 0;
  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ManagerProfile) return { id: 'profile-1', userId: CTX.userId, type: 'internal', workspaceId: null };
      if (entity === ManagerWorkspace) return null;
      return null;
    }),
    create: jest.fn((_e: unknown, values: Record<string, unknown>) => ({ id: 'workspace-1', ...values })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      statements.push('SAVE manager_workspace');
      return row;
    }),
    update: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) => {
      statements.push(sql);
      return sql.includes('org_active') ? [{ org_active: true, account_status: 'active' }] : [];
    }),
  };
  const tenantContext = { runInTenantContext: jest.fn((_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn(manager)) };
  const service = new ManagerWorkspaceService(
    tenantContext as never,
    { assignOwnWorkspace: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
    { checkAvailability: jest.fn(async () => ({ available: true, normalized: 'acme', reserved: false })) } as never,
    {} as never,
    { invalidate: jest.fn(async () => undefined) } as never,
    { provisionOwnWorkspace: jest.fn(async () => 'ALREADY_READY' as const) } as never,
  );
  const s = service as unknown as {
    findReplay: (...a: unknown[]) => Promise<unknown>;
    createFor: (...a: unknown[]) => Promise<unknown>;
  };
  const realCreateFor = s.createFor.bind(service);
  s.findReplay = async () => {
    findReplayCalls += 1;
    // The first look (before createFor) finds nothing; the post-race look finds the winner's workspace when it exists.
    return findReplayCalls > 1 && opts.replay !== false ? REPLAY : null;
  };
  if (opts.createForError !== undefined) {
    s.createFor = async () => {
      createForCalls += 1;
      throw opts.createForError;
    };
  }
  return { service, statements, realCreateFor, calls: () => ({ createForCalls, findReplayCalls }) };
}

describe('ManagerWorkspaceService: concurrent identical creates never become a 500', () => {
  it('createFor takes the per-owner advisory lock FIRST — before the profile / ownership reads and before any write', async () => {
    const h = harness();
    await h.realCreateFor(
      {
        findOne: async (entity: unknown) => {
          h.statements.push(`READ ${entity === ManagerProfile ? 'manager_profile' : 'manager_workspace'}`);
          return entity === ManagerProfile ? { id: 'profile-1', userId: CTX.userId, type: 'internal', workspaceId: null } : null;
        },
        create: (_e: unknown, v: Record<string, unknown>) => ({ id: 'workspace-1', ...v }),
        save: async (row: unknown) => {
          h.statements.push('SAVE manager_workspace');
          return row;
        },
        update: async () => undefined,
        query: async (sql: string) => {
          h.statements.push(sql);
          return [];
        },
      },
      CTX,
      { ownerUserId: CTX.userId, name: 'Acme', subdomain: 'acme' },
    ).catch(() => undefined); // later steps of createFor are not under test here
    expect(h.statements[0]).toBe('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1), pg_catalog.hashtext($2))');
    expect(h.statements.indexOf('READ manager_profile')).toBeGreaterThan(0);
    expect(WORKSPACE_CREATE_LOCK_NAMESPACE).toBe('rab_manager_workspace_create');
  });

  it.each([['40P01 deadlock_detected'], ['40001 serialization_failure']])('%s from createFor → the replay path: 201 with the winner\'s workspace', async (label) => {
    const code = label.slice(0, 5);
    const h = harness({ createForError: Object.assign(new Error(label), { code }) });
    const response = (await h.service.create(CTX as never, DTO as never)) as { id: string };
    expect(response.id).toBe('workspace-1');
    expect(h.calls()).toEqual({ createForCalls: 1, findReplayCalls: 2 });
  });

  it('a TypeORM QueryFailedError carrying 40P01 on driverError is recognised too', () => {
    expect(isRaceLoserError({ driverError: { code: '40P01' } })).toBe(true);
    expect(isRaceLoserError({ code: '40001' })).toBe(true);
    for (const code of ['23505', '42501', '57014', undefined]) expect(isRaceLoserError({ code })).toBe(false);
    expect(isRaceLoserError(null)).toBe(false);
  });

  it('a race loser with NO winner workspace is rethrown (never a fabricated success)', async () => {
    const error = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const h = harness({ createForError: error, replay: false });
    await expect(h.service.create(CTX as never, DTO as never)).rejects.toBe(error);
  });

  it('any other database error is rethrown unchanged (no replay attempt)', async () => {
    const error = Object.assign(new Error('permission denied'), { code: '42501' });
    const h = harness({ createForError: error });
    await expect(h.service.create(CTX as never, DTO as never)).rejects.toBe(error);
    expect(h.calls().findReplayCalls).toBe(1); // only the pre-create look
  });

  it('the existing lost-unique-race path is unchanged: ConflictException → replay', async () => {
    const h = harness({ createForError: new ConflictException('This manager already has a workspace.') });
    const response = (await h.service.create(CTX as never, DTO as never)) as { id: string };
    expect(response.id).toBe('workspace-1');
  });
});
