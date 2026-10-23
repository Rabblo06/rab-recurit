import { InvalidTransitionError } from './invalid-transition-error';
import { assertTransition } from './assert-transition';
import { ARCHIVE_TRANSITIONS, ArchiveState, archiveStateOf } from './archive-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('ARCHIVE_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(ARCHIVE_TRANSITIONS, Object.values(ArchiveState));
  });

  it('refuses archiving an archived record and restoring an active one (no silent no-op)', () => {
    expect(() => assertTransition(ARCHIVE_TRANSITIONS, ArchiveState.ARCHIVED, ArchiveState.ARCHIVED)).toThrow(InvalidTransitionError);
    expect(() => assertTransition(ARCHIVE_TRANSITIONS, ArchiveState.ACTIVE, ArchiveState.ACTIVE)).toThrow(InvalidTransitionError);
  });

  it('refuses an unknown state (fail closed)', () => {
    expect(() => assertTransition(ARCHIVE_TRANSITIONS, 'deleted' as never, ArchiveState.ACTIVE)).toThrow(InvalidTransitionError);
  });

  it('derives the state from archived_at only', () => {
    expect(archiveStateOf(null)).toBe(ArchiveState.ACTIVE);
    expect(archiveStateOf(undefined)).toBe(ArchiveState.ACTIVE);
    expect(archiveStateOf(new Date())).toBe(ArchiveState.ARCHIVED);
    expect(archiveStateOf('2026-10-23T00:00:00Z')).toBe(ArchiveState.ARCHIVED);
  });
});
