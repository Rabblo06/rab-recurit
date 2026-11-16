import { DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { boundSchemaOf } from '../../../engine/core-modules/tenant/schema-bound-entity-manager';
import { assertHwsStartupInvariants, HwsStartupError } from './hws-startup-guard';

/**
 * C2-1 (review I1): the startup guard builds the 'core' schema-bound entity metadata in BOTH modes, so a build-time refusal
 * refuses to start (HwsStartupError) instead of failing the first tenant transaction. No database: with HWS off the guard
 * runs only the C3 cutover check after the warm-up (mocked here).
 */
@Entity({ name: 'c21_guard_ok', schema: 'core' })
class C21GuardOk {
  @PrimaryGeneratedColumn('uuid') id!: string;
}
@Entity({ name: 'c21_guard_lookalike', schema: 'core' })
class C21GuardLookalike {
  static useDataSource(): void {}
  @PrimaryGeneratedColumn('uuid') id!: string;
}

async function built(entities: unknown[]): Promise<DataSource> {
  const ds = new DataSource({ type: 'postgres', entities: entities as never });
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  jest.spyOn(ds, 'query').mockRejectedValue(new Error('no query expected with HWS off'));
  return ds;
}

describe('assertHwsStartupInvariants: C2-1 warm-up of the schema-bound metadata', () => {
  it('HWS off: builds the core metadata source, then runs only the C3 cutover check (M-3)', async () => {
    const ds = await built([C21GuardOk]);
    // Part C3: with HWS off the only query after the warm-up is the read-only "has a cutover started?" check; a database
    // without core.hws_cutover_started_any() (before the C3 migration) has no cutover state, so it stops there.
    (ds.query as jest.Mock).mockResolvedValueOnce([{ present: false }]);
    await expect(assertHwsStartupInvariants(ds, false)).resolves.toBeUndefined();
    expect(ds.query).toHaveBeenCalledTimes(1);
    expect((ds.query as jest.Mock).mock.calls[0][0]).toContain("to_regprocedure('core.hws_cutover_started_any()')");
  });

  it('HWS off: refuses to start once a cutover has started (C3 M-3)', async () => {
    const ds = await built([C21GuardOk]);
    (ds.query as jest.Mock).mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ started: true }]);
    await expect(assertHwsStartupInvariants(ds, false)).rejects.toThrow(/HWS cutover has started on this database/);
  });

  it('a build-time refusal refuses to start (HwsStartupError), whatever the HWS mode', async () => {
    for (const hws of [false, true]) {
      const ds = await built([C21GuardOk, C21GuardLookalike]);
      await expect(assertHwsStartupInvariants(ds, hws)).rejects.toThrow(HwsStartupError);
      await expect(assertHwsStartupInvariants(ds, hws)).rejects.toThrow(/schema-bound entity metadata refused: C21GuardLookalike is a BaseEntity/);
      expect(ds.query).not.toHaveBeenCalled();
    }
  });

  it('exports nothing that binds a manager by itself (the warm-up only builds metadata)', () => {
    expect(boundSchemaOf(undefined)).toBeNull();
  });
});
