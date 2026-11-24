import 'reflect-metadata';
import { DataSource, EntityManager } from 'typeorm';

import { ManagerProfile } from '../../../modules/manager/entities';
import { Organisation, Role, User, UserRole } from '../identity/entities';
import { ManagerVenue } from './entities/manager-venue.entity';
import { ResourceScopeService } from './resource-scope.service';

/**
 * engine/ never imports modules/: ResourceScopeService used to INNER JOIN the ManagerProfile entity (modules/manager) and now
 * filters by `mv.manager_profile_id IN (SELECT mp.id FROM core.manager_profile mp WHERE mp.user_id = :userId)`, while
 * ManagerVenue moved into engine. The venue-manager scope is an authorisation input. Row equivalence: mp.id is the primary
 * key, so each manager_venue row joined at most one profile; the IN keeps exactly the rows the join kept, once each. The live
 * behaviour (assign -> visible, unassign -> gone, another manager's venue -> invisible) is covered end to end by
 * __tests__/integration/venue-manager-scoping.integration.spec.ts. Here: the statement and the result mapping, on
 * metadata-only DataSources (never initialised, no connection), unbound and schema-bound the way SchemaBoundEntityManager
 * builds them.
 */
async function metadataSource(schema?: string): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    ...(schema ? { schema } : {}),
    entities: [ManagerVenue, ManagerProfile, User, Organisation, Role, UserRole],
  });
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return ds;
}

/** Runs resolveTx on a manager whose query builders are real (so the SQL is TypeORM's own) but return canned rows. */
async function resolveWith(ds: DataSource, roleKeys: string[], venueIds: string[]) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  let call = 0;
  const manager = {
    createQueryBuilder: (target: unknown, alias: string) => {
      const qb = ds.createQueryBuilder(target as never, alias);
      qb.getRawMany = (async () => {
        const [sql, params] = qb.getQueryAndParameters();
        issued.push({ sql, params });
        return call++ === 0 ? roleKeys.map((key) => ({ key })) : venueIds.map((venueId) => ({ venueId }));
      }) as never;
      return qb;
    },
    query: async () => [],
  } as unknown as EntityManager;
  const scope = await new ResourceScopeService().resolveTx(manager, { organisationId: 'org-1', userId: 'user-1' });
  return { scope, issued };
}

describe('ResourceScopeService venue scope after the engine/modules untangle', () => {
  it.each([
    ['core routing', undefined],
    ['a workspace schema (HWS on)', 'workspace_0123456789abcdef0123456789abcdef'],
  ])('reads manager_venue through the entity (schema binding kept) and core.manager_profile by table name (%s)', async (_label, schema) => {
    const { scope, issued } = await resolveWith(await metadataSource(schema), ['venue_manager'], ['v-1', 'v-2']);

    expect(scope).toEqual({ kind: 'venue', venueIds: ['v-1', 'v-2'] });
    expect(issued).toHaveLength(2);
    const { sql, params } = issued[1]!;
    expect(sql).toBe(
      `SELECT "mv"."venue_id" AS "venueId" FROM ${schema ? `"${schema}".` : ''}"manager_venue" "mv" ` +
        'WHERE "mv"."manager_profile_id" IN (SELECT mp.id FROM core.manager_profile mp WHERE mp.user_id = $1)',
    );
    // The user id is a bound parameter, never interpolated.
    expect(params).toEqual(['user-1']);
  });

  it('a venue manager with no assignment gets an empty venue scope (fail closed), not an owner scope', async () => {
    const { scope } = await resolveWith(await metadataSource(), ['venue_manager'], []);
    expect(scope).toEqual({ kind: 'venue', venueIds: [] });
  });

  it('a non-venue-manager never reaches the venue query', async () => {
    const { scope, issued } = await resolveWith(await metadataSource(), ['manager'], ['v-1']);
    expect(scope).toEqual({ kind: 'owner', ownerUserId: 'user-1', delegated: false });
    expect(issued).toHaveLength(1);
  });
});
