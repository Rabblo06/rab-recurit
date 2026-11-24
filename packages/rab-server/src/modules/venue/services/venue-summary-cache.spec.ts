import { Venue } from '../entities/venue.entity';
import { venueSummaryCached } from './venue-summary-cache';

/**
 * The venue display summary moved out of engine/'s CoreEntityCacheService.getVenueSummary (engine/ never imports modules/).
 * SchedulingService reads it for notification text. It must keep the cache kind and key the engine method used, or entries
 * written before the move would be orphaned and `invalidate('venue', id)` would stop reaching them; and it must keep the
 * projection (four display fields, nothing else from the row).
 */
describe('venueSummaryCached', () => {
  const passThrough = () => ({
    getOrFetch: jest.fn(async (_kind: string, _id: string, fetch: () => Promise<unknown>) => fetch()),
  });

  it("uses kind 'venue' keyed by the venue id, reads Venue by id on a miss and projects the same four fields", async () => {
    const row = Object.assign(new Venue(), {
      id: 'venue-1',
      organisationId: 'org-1',
      workspaceId: 'ws-1',
      name: 'The Grand Hall',
      clientName: 'Acme Events',
      accessNotes: 'gate code 1234',
    });
    const manager = { findOne: jest.fn(async () => row) };
    const cache = passThrough();

    const out = await venueSummaryCached(cache as never, manager as never, 'venue-1');

    expect(cache.getOrFetch).toHaveBeenCalledTimes(1);
    expect(cache.getOrFetch.mock.calls[0]!.slice(0, 2)).toEqual(['venue', 'venue-1']);
    // No `enabled` / `ttlSeconds` argument: the service's own on/off switch and the default TTL apply, as before.
    expect(cache.getOrFetch.mock.calls[0]).toHaveLength(3);
    expect(manager.findOne).toHaveBeenCalledWith(Venue, { where: { id: 'venue-1' } });
    expect(out).toEqual({ id: 'venue-1', organisationId: 'org-1', workspaceId: 'ws-1', name: 'The Grand Hall' });
  });

  it('maps a missing workspace id to null', async () => {
    const row = Object.assign(new Venue(), { id: 'venue-2', organisationId: 'org-1', workspaceId: undefined, name: 'Pier' });
    const out = await venueSummaryCached(passThrough() as never, { findOne: jest.fn(async () => row) } as never, 'venue-2');
    expect(out).toEqual({ id: 'venue-2', organisationId: 'org-1', workspaceId: null, name: 'Pier' });
  });

  it('returns null (never cached by getOrFetch) for a venue the caller cannot see', async () => {
    const out = await venueSummaryCached(passThrough() as never, { findOne: jest.fn(async () => null) } as never, 'venue-3');
    expect(out).toBeNull();
  });

  it('returns a cache hit without reading the database', async () => {
    const hit = { id: 'venue-4', organisationId: 'org-1', workspaceId: 'ws-1', name: 'Cached' };
    const cache = { getOrFetch: jest.fn(async () => hit) };
    const manager = { findOne: jest.fn() };
    await expect(venueSummaryCached(cache as never, manager as never, 'venue-4')).resolves.toBe(hit);
    expect(manager.findOne).not.toHaveBeenCalled();
  });
});
