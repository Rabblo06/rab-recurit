import { isEligibleReplacementCandidate, withoutCandidateScores } from '@rab/shared';

import { CandidateFacts, MAX_NOT_ELIGIBLE_LISTED, buildReplacementCandidates } from './replacement-candidates';

/**
 * Owner decision 8: "eligible staff, with the reasons shown". These tests pin that no computed value ever orders
 * named people: the order is by name only, nobody eligible is cut, and no score is written.
 */
const ROLE = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ROLE = '00000000-0000-4000-8000-0000000000bb';
// 2026-07-17 10:00 UTC = 11:00 BST, a Friday in London.
const shift = { jobRoleId: ROLE, startsAt: new Date('2026-07-17T10:00:00.000Z') };

let seq = 0;
function facts(firstName: string, lastName: string, o: Partial<CandidateFacts> = {}): CandidateFacts {
  seq += 1;
  return {
    staff_profile_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    first_name: firstName,
    last_name: lastName,
    job_role_id: ROLE,
    available_days: null,
    no_overlap: true,
    not_already_offered: true,
    ...o,
  };
}

describe('buildReplacementCandidates (decision 8: no score, no ranking)', () => {
  it('writes no score on any entry', () => {
    const list = buildReplacementCandidates([facts('Ann', 'Zed'), facts('Bob', 'Young', { job_role_id: OTHER_ROLE })], shift, 'Bartender');
    for (const c of list) expect(c).not.toHaveProperty('score');
  });

  it('orders eligible people by last name, then first name, whatever the input order (never by a computed value)', () => {
    const rows = [facts('Cara', 'Smith'), facts('Abe', 'Jones'), facts('Ben', 'Smith'), facts('Dan', 'adams')];
    const expected = ['adams Dan', 'Jones Abe', 'Smith Ben', 'Smith Cara'];
    const names = (input: CandidateFacts[]) => buildReplacementCandidates(input, shift, 'Bartender').map((c) => `${c.lastName} ${c.firstName}`);
    expect(names(rows)).toEqual(expected);
    expect(names([...rows].reverse())).toEqual(expected);
  });

  it('the facts that used to earn points (previous venue work, skills, few commitments) cannot change the order', () => {
    // The old score gave +20 for previous venue work, +10 for a listed skill and up to +9 for few commitments. The new
    // input type has no such fields at all; extra columns smuggled in are ignored.
    const busy = { ...facts('Amy', 'Brown'), worked_venue_before: false, other_skills: null, pending_commitments: '9' } as CandidateFacts;
    const favoured = { ...facts('Zoe', 'Young'), worked_venue_before: true, other_skills: 'Bartender', pending_commitments: '0' } as CandidateFacts;
    const list = buildReplacementCandidates([favoured, busy], shift, 'Bartender');
    expect(list.map((c) => c.firstName)).toEqual(['Amy', 'Zoe']);
  });

  it('identical names sort by id, so the order is stable on every run', () => {
    const a = facts('Sam', 'Lee');
    const b = facts('Sam', 'Lee');
    const list = buildReplacementCandidates([b, a], shift, 'Bartender');
    expect(list.map((c) => c.staffProfileId)).toEqual([a.staff_profile_id, b.staff_profile_id].sort());
  });

  it('never cuts the eligible list: 50 eligible people are all listed (the old shortlist kept the top 5 by score)', () => {
    const rows = Array.from({ length: 50 }, (_, i) => facts(`F${i}`, `L${String(i).padStart(2, '0')}`));
    const list = buildReplacementCandidates(rows, shift, 'Bartender');
    expect(list.filter(isEligibleReplacementCandidate)).toHaveLength(50);
  });

  it('eligible people carry the plain reasons they qualify', () => {
    const [withDays] = buildReplacementCandidates([facts('Ann', 'A', { available_days: ['Friday'] })], shift, 'Bartender');
    expect(withDays).toMatchObject({ eligible: true, reasons: ['Has the Bartender role', 'Available on Friday', 'No clash with a confirmed shift', 'Not already offered this shift'] });
    const [noDays] = buildReplacementCandidates([facts('Bob', 'B')], shift, 'Bartender');
    expect(noDays!.reasons).toContain('No unavailable days recorded');
  });

  it('lists the not-eligible people after the eligible ones, in name order, with every reason why', () => {
    const list = buildReplacementCandidates(
      [
        facts('Zed', 'Able'),
        facts('Wrong', 'Role', { job_role_id: OTHER_ROLE }),
        facts('No', 'Role', { job_role_id: null }),
        facts('Thu', 'Only', { available_days: ['Thursday'] }),
        facts('Busy', 'Clash', { no_overlap: false, not_already_offered: false }),
      ],
      shift,
      'Bartender',
    );
    expect(list.map((c) => [c.lastName, c.eligible])).toEqual([
      ['Able', true],
      ['Clash', false],
      ['Only', false],
      ['Role', false],
      ['Role', false],
    ]);
    const byFirst = Object.fromEntries(list.map((c) => [c.firstName, c.reasons]));
    expect(byFirst.Wrong).toEqual(['Does not have the Bartender role']);
    expect(byFirst.No).toEqual(['No job role recorded']);
    expect(byFirst.Thu).toEqual(['Not available on Friday']);
    expect(byFirst.Busy).toEqual(['Already on a confirmed shift at this time', 'Already offered this shift']);
    expect(list.filter((c) => !isEligibleReplacementCandidate(c))).toHaveLength(4);
  });

  it('bounds only the not-eligible part of the stored list', () => {
    const rows = [
      facts('Only', 'Eligible'),
      ...Array.from({ length: MAX_NOT_ELIGIBLE_LISTED + 5 }, (_, i) => facts(`N${i}`, `X${String(i).padStart(3, '0')}`, { job_role_id: OTHER_ROLE })),
    ];
    const list = buildReplacementCandidates(rows, shift, 'Bartender');
    expect(list.filter(isEligibleReplacementCandidate)).toHaveLength(1);
    expect(list.filter((c) => !isEligibleReplacementCandidate(c))).toHaveLength(MAX_NOT_ELIGIBLE_LISTED);
  });

  it('judges availability by the London weekday (a shift just after midnight BST is the next day)', () => {
    const lateShift = { jobRoleId: ROLE, startsAt: new Date('2026-07-16T23:30:00.000Z') }; // UTC Thu, London Fri
    const [c] = buildReplacementCandidates([facts('Fri', 'Day', { available_days: ['Friday'] })], lateShift, 'Bartender');
    expect(c!.eligible).toBe(true);
  });
});

describe('shared candidate helpers', () => {
  it('a row written before decision 8 (no eligible field) stays approvable; eligible:false never is', () => {
    expect(isEligibleReplacementCandidate({})).toBe(true);
    expect(isEligibleReplacementCandidate({ eligible: true })).toBe(true);
    expect(isEligibleReplacementCandidate({ eligible: false })).toBe(false);
  });

  it('the API view drops a legacy score and keeps the stored order', () => {
    const legacy = [
      { staffProfileId: 'b', firstName: 'B', lastName: 'B', score: 80, reasons: ['Exact job-role match'] },
      { staffProfileId: 'a', firstName: 'A', lastName: 'A', score: 9, reasons: [] },
    ];
    const shown = withoutCandidateScores(legacy);
    expect(shown.map((c) => c.staffProfileId)).toEqual(['b', 'a']);
    for (const c of shown) expect(c).not.toHaveProperty('score');
    expect(withoutCandidateScores(null)).toEqual([]);
  });
});
