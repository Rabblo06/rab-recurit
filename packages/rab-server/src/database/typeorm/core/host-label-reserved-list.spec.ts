import { RESERVED_SUBDOMAINS } from '@rab/shared';

import { HOST_LABEL_RESERVED_SEED, RAB_SHARED_RESERVED_SUBDOMAINS_AT_MIGRATION, TWENTY_RESERVED_SUBDOMAINS } from './host-label-reserved-list';

/** Wave 2/3 lane S2 (C2): the DB reserved list is a superset of every source list and only holds valid label shapes. */
describe('host label reserved seed', () => {
  const seed = new Set(HOST_LABEL_RESERVED_SEED.map((r) => r.label));

  it('is a superset of the live @rab/shared RESERVED_SUBDOMAINS (lane H may only add to the DB list, never fall behind it)', () => {
    for (const l of RESERVED_SUBDOMAINS) expect(seed.has(l)).toBe(true);
    for (const l of RAB_SHARED_RESERVED_SUBDOMAINS_AT_MIGRATION) expect(seed.has(l)).toBe(true);
  });

  it("contains every entry of Twenty's list (121 entries) and the brand names", () => {
    expect(TWENTY_RESERVED_SUBDOMAINS).toHaveLength(121);
    for (const l of TWENTY_RESERVED_SUBDOMAINS) expect(seed.has(l)).toBe(true);
    for (const l of ['crewflow', 'adolphus', 'rab']) expect(seed.has(l)).toBe(true);
  });

  it('has no duplicates, is sorted, and every label is a lower-case DNS label (the DB CHECK shape)', () => {
    const labels = HOST_LABEL_RESERVED_SEED.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect([...labels].sort()).toEqual(labels);
    for (const l of labels) expect(l).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  });
});
