import { overlappingWithinBatch } from './multi-shift-send-plan';

const at = (h: number) => new Date(Date.UTC(2030, 0, 1, h));
const row = (shiftId: string, staffProfileId: string, from: number, to: number) => ({ shiftId, staffProfileId, startsAt: at(from), endsAt: at(to) });

describe('overlappingWithinBatch', () => {
  it('flags both rows when one person is planned on two overlapping shifts', () => {
    const failures = overlappingWithinBatch([row('s1', 'p', 9, 15), row('s2', 'p', 13, 19), row('s2', 'q', 13, 19)]);
    expect(failures.map((f) => [f.shiftId, f.staffProfileId])).toEqual([
      ['s1', 'p'],
      ['s2', 'p'],
    ]);
  });

  it('back-to-back shifts and different people never clash (half-open windows)', () => {
    expect(overlappingWithinBatch([row('s1', 'p', 9, 13), row('s2', 'p', 13, 17), row('s3', 'q', 10, 12), row('s4', 'r', 10, 12)])).toEqual([]);
  });
});
