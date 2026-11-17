import { pickFields } from './pick-fields.util';

describe('pickFields (SF-7 explicit field map)', () => {
  type Dto = { name?: string; note?: string | null; count?: number };
  const FIELDS = ['name', 'note', 'count'] as const;

  it('copies only the listed keys: an undeclared key on the object is never carried into the result', () => {
    const hostile = { name: 'Kept', organisationId: 'other-org', createdBy: 'someone-else', status: 'archived', staffRef: 'X' };
    const picked = pickFields(hostile as Dto, FIELDS);
    expect(picked).toEqual({ name: 'Kept' });
    expect(Object.keys(picked)).toEqual(['name']);
  });

  it('skips undefined (an absent field is not written) but keeps null (a nullable field being cleared) and falsy values', () => {
    expect(pickFields<Dto, (typeof FIELDS)[number]>({ name: undefined, note: null, count: 0 }, FIELDS)).toEqual({ note: null, count: 0 });
  });

  it('reads own properties only: an inherited key is not copied', () => {
    const proto = { name: 'from-prototype' };
    const source = Object.create(proto) as Dto;
    source.count = 3;
    expect(pickFields(source, FIELDS)).toEqual({ count: 3 });
  });

  it('returns a new object and never mutates the source', () => {
    const source: Dto = { name: 'A', count: 1 };
    const picked = pickFields(source, ['name'] as const);
    expect(picked).not.toBe(source);
    expect(source).toEqual({ name: 'A', count: 1 });
  });
});
