import { DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { boundSchemaOf } from '../../../engine/core-modules/tenant/schema-bound-entity-manager';
import { assertHwsStartupInvariants, HwsStartupError } from './hws-startup-guard';

/**
 * C2-1 (review I1): the startup guard builds the 'core' schema-bound entity metadata in BOTH modes, so a build-time refusal
 * refuses to start (HwsStartupError) instead of failing the first tenant transaction. No database: with HWS off the guard
 * runs no query after the warm-up.
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
  it('HWS off: builds the core metadata source and runs no query', async () => {
    const ds = await built([C21GuardOk]);
    await expect(assertHwsStartupInvariants(ds, false)).resolves.toBeUndefined();
    expect(ds.query).not.toHaveBeenCalled();
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
