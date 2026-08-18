import { InvalidTransitionError } from './invalid-transition-error';

export type TransitionTable<S extends string> = Record<S, readonly S[]>;

/**
 * No endpoint ever accepts a raw `status` value from a client — mutations
 * name the action (`publishShift`, `acceptOffer`), never
 * `updateShift({ status: 'published' })`. Services call this to validate
 * every status change against the transition table for that entity. Unknown
 * state is deny, not pass-through — see rab-workforce-architecture.md §1.1.
 */
export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  const allowed = table[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
