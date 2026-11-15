import { EntityManager } from 'typeorm';

import { FieldMetadata, FieldMetadataOption, IndexFieldMetadata, IndexMetadata, ObjectMetadata } from '../entities';
import { MetadataContextError, MetadataReadService, nest } from '../services/metadata-read.service';

/** A manager that answers the tenant probe with `bound` and records every other call. */
function fakeManager(bound: { organisation_id: string | null; workspace_id: string | null }) {
  const calls: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      return [bound];
    }),
    find: jest.fn(async (entity: { name: string }, options: unknown) => {
      calls.push(`find ${entity.name} ${JSON.stringify(options)}`);
      return [];
    }),
    findOne: jest.fn(async (entity: { name: string }, options: unknown) => {
      calls.push(`findOne ${entity.name} ${JSON.stringify(options)}`);
      return null;
    }),
  };
  return { manager: manager as unknown as EntityManager, calls };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';

describe('MetadataReadService (layer 2: refuses without a bound tenant; reads only the bound workspace)', () => {
  const service = new MetadataReadService();

  it.each([
    [{ organisation_id: null, workspace_id: null }],
    [{ organisation_id: ORG, workspace_id: null }],
    [{ organisation_id: null, workspace_id: WS }],
    [{ organisation_id: '', workspace_id: '' }],
  ])('refuses %j before any metadata query', async (bound) => {
    const { manager, calls } = fakeManager(bound);
    await expect(service.readWorkspaceMetadata(manager)).rejects.toBeInstanceOf(MetadataContextError);
    await expect(service.findObjectById(manager, 'x')).rejects.toBeInstanceOf(MetadataContextError);
    await expect(service.findObjectByNamePlural(manager, 'x')).rejects.toBeInstanceOf(MetadataContextError);
    expect(calls.every((c) => c.startsWith('SELECT core.current_org()'))).toBe(true);
  });

  it('filters every read on the organisation AND workspace taken from the transaction, never from an argument', async () => {
    const { manager, calls } = fakeManager({ organisation_id: ORG, workspace_id: WS });
    const snapshot = await service.readWorkspaceMetadata(manager);
    expect(snapshot).toEqual({ organisationId: ORG, workspaceId: WS, objects: [] });
    const finds = calls.filter((c) => c.startsWith('find '));
    expect(finds.map((c) => c.split(' ')[1])).toEqual(['ObjectMetadata', 'FieldMetadata', 'FieldMetadataOption', 'IndexMetadata', 'IndexFieldMetadata']);
    for (const c of finds) expect(c).toContain(JSON.stringify({ where: { organisationId: ORG, workspaceId: WS } }));
    await service.findObjectById(manager, 'abc');
    expect(calls.at(-1)).toBe(`findOne ObjectMetadata ${JSON.stringify({ where: { id: 'abc', organisationId: ORG, workspaceId: WS } })}`);
  });
});

describe('nest (deterministic snapshot order)', () => {
  const o = (id: string, namePlural: string) => Object.assign(new ObjectMetadata(), { id, namePlural });
  const f = (id: string, objectMetadataId: string, name: string, position: number) => Object.assign(new FieldMetadata(), { id, objectMetadataId, name, position });
  const opt = (fieldMetadataId: string, value: string, position: number) => Object.assign(new FieldMetadataOption(), { fieldMetadataId, value, position });
  const ix = (id: string, objectMetadataId: string, physicalName: string) => Object.assign(new IndexMetadata(), { id, objectMetadataId, physicalName });
  const ixf = (indexMetadataId: string, fieldMetadataId: string, position: number) => Object.assign(new IndexFieldMetadata(), { indexMetadataId, fieldMetadataId, position });

  it('sorts objects by plural name, fields by position then name, options by position then value, indexes by name', () => {
    const out = nest(
      [o('2', 'venues'), o('1', 'equipments')],
      [f('f3', '1', 'b', 1), f('f2', '1', 'a', 1), f('f1', '1', 'z', 0), f('f4', '2', 'id', 0)],
      [opt('f2', 'B', 1), opt('f2', 'A', 1), opt('f2', 'C', 0)],
      [ix('i2', '1', 'ix_b'), ix('i1', '1', 'ix_a')],
      [ixf('i1', 'f3', 1), ixf('i1', 'f2', 0)],
    );
    expect(out.map((x) => x.namePlural)).toEqual(['equipments', 'venues']);
    expect(out[0]!.fields.map((x) => x.id)).toEqual(['f1', 'f2', 'f3']);
    expect(out[0]!.fields[1]!.options.map((x) => x.value)).toEqual(['C', 'A', 'B']);
    expect(out[0]!.indexes.map((x) => x.physicalName)).toEqual(['ix_a', 'ix_b']);
    expect(out[0]!.indexes[0]!.fields.map((x) => x.fieldMetadataId)).toEqual(['f2', 'f3']);
    expect(out[1]!.fields.map((x) => x.id)).toEqual(['f4']);
    expect(out[1]!.indexes).toEqual([]);
  });

  it('is independent of the input order (same rows, any order → identical output)', () => {
    const objects = [o('1', 'a'), o('2', 'b'), o('3', 'c')];
    const fields = [f('x', '1', 'p', 2), f('y', '1', 'q', 1), f('z', '3', 'r', 0)];
    expect(nest([...objects].reverse(), [...fields].reverse(), [], [], [])).toEqual(nest(objects, fields, [], [], []));
  });
});
