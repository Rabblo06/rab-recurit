import { ValidationPipe } from '@nestjs/common';
import { SubmitShiftRequestDto } from '../dto/submit-shift-request.dto';
import { effectiveAssignmentTime, validateAssignmentTime, assignmentTimeSql, effectiveAssignmentBreakMinutes, assignmentEnvelope } from './assignment-time';
const parent = { startsAt: new Date('2026-10-14T21:00:00Z'), endsAt: new Date('2026-10-15T05:00:00Z') };
const midnight = { startsAt: new Date('2026-10-15T00:00:00Z'), endsAt: parent.endsAt };
describe('canonical assignment time', () => {
  it.each(['["2026-10-15 00:00:00+00","2026-10-15 05:00:00+00")', '[2026-10-15T00:00:00.000Z,2026-10-15T05:00:00.000Z)'])('reads PostgreSQL range %s', period => {
    expect(effectiveAssignmentTime({ period }, parent)).toEqual(midnight);
  });
  it('falls back without changing historical data', () => {
    const assignment = { period: null };
    expect(effectiveAssignmentTime(assignment, parent)).toEqual(parent);
    expect(assignment.period).toBeNull();
  });
  it('accepts contained overnight time and the existing shared break', () => {
    expect(validateAssignmentTime(parent, midnight, 30)).toEqual(midnight);
  });
  it.each([
    { startsAt: midnight.startsAt, endsAt: midnight.startsAt },
    { startsAt: new Date('invalid'), endsAt: parent.endsAt },
  ])('rejects invalid boundaries', proposed => expect(() => validateAssignmentTime(parent, proposed)).toThrow());
  it.each([-1, 300, 301, 0.5])('rejects invalid break %s', minutes => expect(() => validateAssignmentTime(parent, midnight, minutes)).toThrow());
  it('never silently falls back from corrupt nonempty periods', () => expect(() => effectiveAssignmentTime({ period: 'bad' }, parent)).toThrow());
  it('keeps SQL aliases trusted', () => {
    expect(assignmentTimeSql().start).toBe('COALESCE(lower(sa.period), s.starts_at)');
    expect(() => assignmentTimeSql('untrusted;')).toThrow();
  });
});

it('extends the operational envelope and resolves nullable breaks', () => {
  const extended = { startsAt: new Date('2026-10-14T19:00:00Z'), endsAt: new Date('2026-10-15T09:00:00Z') };
  expect(validateAssignmentTime(parent, extended, 60)).toEqual(extended);
  expect(assignmentEnvelope(parent, [midnight, extended])).toEqual(extended);
  expect(effectiveAssignmentBreakMinutes(null, { breakMinutes: 30 })).toBe(30);
  expect(effectiveAssignmentBreakMinutes({ breakMinutes: 0 }, { breakMinutes: 30 })).toBe(0);
  expect(effectiveAssignmentBreakMinutes({ breakMinutes: 60 }, { breakMinutes: 30 })).toBe(60);
});

describe('request assignment whitelist', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const payload = { venueId: id, jobRoleId: id, startsAt: parent.startsAt.toISOString(), endsAt: parent.endsAt.toISOString(), staffRequired: 1, staffProfileIds: [id], staffAssignments: [{ staffProfileId: id, startsAt: parent.startsAt.toISOString(), endsAt: '2026-10-15T09:00:00Z', breakMinutes: 60 }] };
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const parse = (value: unknown) => pipe.transform(value, { type: 'body', metatype: SubmitShiftRequestDto });
  it('accepts the actual mobile contract and nullable break', async () => {
    await expect(parse(payload)).resolves.toBeInstanceOf(SubmitShiftRequestDto);
    await expect(parse({ ...payload, staffAssignments: [{ ...payload.staffAssignments[0], breakMinutes: null }] })).resolves.toBeDefined();
  });
  it('rejects unknown top-level and nested fields', async () => {
    await expect(parse({ ...payload, hackerField: true })).rejects.toThrow();
    await expect(parse({ ...payload, staffAssignments: [{ ...payload.staffAssignments[0], workspaceId: id }] })).rejects.toThrow();
  });
  it.each([-1, 0.5, '60'])('rejects invalid nested break %s', async breakMinutes => {
    await expect(parse({ ...payload, staffAssignments: [{ ...payload.staffAssignments[0], breakMinutes }] })).rejects.toThrow();
  });
});
