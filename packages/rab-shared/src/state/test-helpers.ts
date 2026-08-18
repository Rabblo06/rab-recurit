import { assertTransition, TransitionTable } from './assert-transition';

/**
 * Exhaustively checks a transition table against the full set of possible
 * states: every listed transition must succeed, every unlisted one must
 * throw. Used by every *-transitions.spec.ts so a table edit that quietly
 * over- or under-permits a transition fails the build.
 */
export function expectExhaustiveTransitionTable<S extends string>(
  table: TransitionTable<S>,
  allStates: readonly S[],
): void {
  for (const from of allStates) {
    const allowed = new Set(table[from]);
    for (const to of allStates) {
      if (allowed.has(to)) {
        expect(() => assertTransition(table, from, to)).not.toThrow();
      } else {
        expect(() => assertTransition(table, from, to)).toThrow();
      }
    }
  }
}
