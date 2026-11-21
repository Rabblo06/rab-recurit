import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ShiftAssignmentStatus, ShiftAssignmentStatusType, ShiftStatus } from '../types';
import { assertTransition } from './assert-transition';
import { OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS, SHIFT_ASSIGNMENT_TRANSITIONS, SHIFT_TRANSITIONS } from './shift-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('SHIFT_TRANSITIONS', () => {
  it('exhaustively matches the documented table (§1.1)', () => {
    expectExhaustiveTransitionTable(SHIFT_TRANSITIONS, Object.values(ShiftStatus));
  });

  it('has no transitions out of completed or cancelled', () => {
    expect(SHIFT_TRANSITIONS[ShiftStatus.COMPLETED]).toEqual([]);
    expect(SHIFT_TRANSITIONS[ShiftStatus.CANCELLED]).toEqual([]);
  });
});

describe('SHIFT_ASSIGNMENT_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(SHIFT_ASSIGNMENT_TRANSITIONS, Object.values(ShiftAssignmentStatus));
  });

  it('a provisional no-show can only be superseded by recorded attendance (completed), never re-confirmed or cancelled', () => {
    expect(SHIFT_ASSIGNMENT_TRANSITIONS[ShiftAssignmentStatus.NO_SHOW]).toEqual([ShiftAssignmentStatus.COMPLETED]);
    expect(SHIFT_ASSIGNMENT_TRANSITIONS[ShiftAssignmentStatus.COMPLETED]).toEqual([]);
  });
});

describe('OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS (M4 D6, offline sync only)', () => {
  it('names exactly one edge: a provisional no-show superseded by an offline clock-in (no_show -> confirmed)', () => {
    expectExhaustiveTransitionTable(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS, Object.values(ShiftAssignmentStatus));
    const edges = Object.entries(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS).flatMap(([from, to]) => to.map((t) => `${from}->${t}`));
    expect(edges).toEqual(['no_show->confirmed']);
  });

  it('the general table still refuses no_show -> confirmed: no other caller gains the edge', () => {
    expect(() => assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus.NO_SHOW, ShiftAssignmentStatus.CONFIRMED)).toThrow();
    expect(Object.isFrozen(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS)).toBe(true);
    for (const list of Object.values(OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS)) expect(Object.isFrozen(list)).toBe(true);
    expect(() => (OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS[ShiftAssignmentStatus.CONFIRMED] as ShiftAssignmentStatusType[]).push(ShiftAssignmentStatus.COMPLETED)).toThrow();
  });

  it('static: only the offline sync service may import it (no manager action or job can reach the edge)', () => {
    const PACKAGES = join(__dirname, '..', '..', '..');
    const ALLOWED = new Set(['rab-server/src/modules/attendance/services/offline-sync.service.ts']);
    const walk = (dir: string): string[] => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      return names.flatMap((n) => {
        const p = join(dir, n);
        if (['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'build', '.dart_tool'].includes(n)) return [];
        if (statSync(p).isDirectory()) return walk(p);
        return /\.(ts|tsx|js|cjs|mjs)$/.test(n) && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(n) ? [p] : [];
      });
    };
    const users = ['rab-server/src', 'rab-worker/src', 'rab-front/src', 'rab-ui/src']
      .flatMap((d) => walk(join(PACKAGES, d)))
      .filter((p) => readFileSync(p, 'utf8').includes('OFFLINE_SYNC_ASSIGNMENT_TRANSITIONS'))
      .map((p) => relative(PACKAGES, p).split(sep).join('/'));
    expect(users.filter((u) => !ALLOWED.has(u))).toEqual([]);
  });
});
