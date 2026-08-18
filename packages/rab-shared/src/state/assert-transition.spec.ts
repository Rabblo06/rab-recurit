import { assertTransition } from './assert-transition';
import { InvalidTransitionError } from './invalid-transition-error';

const table = {
  a: ['b', 'c'],
  b: ['c'],
  c: [],
} as const;

describe('assertTransition', () => {
  it('allows a transition listed in the table', () => {
    expect(() => assertTransition(table, 'a', 'b')).not.toThrow();
  });

  it('rejects a transition not listed for the current state', () => {
    expect(() => assertTransition(table, 'b', 'a')).toThrow(InvalidTransitionError);
  });

  it('rejects any transition out of a terminal state', () => {
    expect(() => assertTransition(table, 'c', 'a')).toThrow(InvalidTransitionError);
  });

  it('names the from/to states on the thrown error', () => {
    try {
      assertTransition(table, 'b', 'a');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).from).toBe('b');
      expect((error as InvalidTransitionError).to).toBe('a');
    }
  });
});
