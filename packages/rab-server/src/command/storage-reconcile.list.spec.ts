import { StorageReconcileCommand } from './storage-reconcile.command';

/**
 * Phase A (storage) — the per-row storage view in `list` mode, without a database: which rows the listing settles on its
 * own and which still get a (fresh) HEAD. The integration spec storage-reconcile-list-lock proves the same against
 * PostgreSQL + MinIO; this pins the decision table.
 */
describe('storage reconcile: list-mode probe', () => {
  const KEY = 'test/organisations/o/workspaces/w/avatars/r/x.png';
  const head = jest.fn(async (key: string) => (key === KEY ? { sizeBytes: 10 } : null));
  const drivers = { getDriver: () => ({ head }) };
  const command = new StorageReconcileCommand({} as never, drivers as never, { get: () => 'test/' } as never, {} as never);
  const probe = (row: { status: string; size_bytes?: string }, listing: Map<string, number> | null) =>
    (command as unknown as { probe: (r: unknown, l: Map<string, number> | null) => Promise<unknown> }).probe(
      { object_key: KEY, size_bytes: '10', ...row },
      listing,
    );

  beforeEach(() => head.mockClear());

  it('AVAILABLE, listed with the expected size → settled by the listing (no HEAD)', async () => {
    await expect(probe({ status: 'AVAILABLE' }, new Map([[KEY, 10]]))).resolves.toEqual({ sizeBytes: 10 });
    expect(head).not.toHaveBeenCalled();
  });

  it('AVAILABLE, absent from the listing → HEAD decides (an object written after the listing is never reported missing)', async () => {
    await expect(probe({ status: 'AVAILABLE' }, new Map())).resolves.toEqual({ sizeBytes: 10 });
    expect(head).toHaveBeenCalledTimes(1);
  });

  it('AVAILABLE, listed with a different size → HEAD decides the reported size', async () => {
    await expect(probe({ status: 'AVAILABLE', size_bytes: '11' }, new Map([[KEY, 99]]))).resolves.toEqual({ sizeBytes: 10 });
    expect(head).toHaveBeenCalledTimes(1);
  });

  it('DELETED/FAILED: not listed → no storage call at all; listed → one fresh HEAD', async () => {
    for (const status of ['DELETED', 'FAILED']) {
      await expect(probe({ status }, new Map())).resolves.toBeNull();
      expect(head).not.toHaveBeenCalled();
      await expect(probe({ status }, new Map([[KEY, 10]]))).resolves.toEqual({ sizeBytes: 10 });
      expect(head).toHaveBeenCalledTimes(1);
      head.mockClear();
    }
  });

  it('PENDING (and any unknown status) → never a storage call: the decision never reads it', async () => {
    for (const status of ['PENDING', 'SOMETHING_NEW']) {
      await expect(probe({ status }, new Map([[KEY, 10]]))).resolves.toBeNull();
    }
    expect(head).not.toHaveBeenCalled();
  });

  it('head mode (rollback, listing null) → exactly one HEAD per row, whatever the status', async () => {
    for (const status of ['AVAILABLE', 'PENDING', 'DELETED', 'FAILED']) await probe({ status }, null);
    expect(head).toHaveBeenCalledTimes(4);
  });
});
