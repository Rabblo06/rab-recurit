import { AiProposalStatus } from '../types/ai-proposals';
import { AI_PROPOSAL_TRANSITIONS, AI_TERMINAL_PROPOSAL_STATUSES } from './ai-proposal-transitions';
import { assertTransition } from './assert-transition';
import { InvalidTransitionError } from './invalid-transition-error';
import { expectExhaustiveTransitionTable } from './test-helpers';

/** T5-S1: the proposal state machine is exhaustive; every edge it does not list throws InvalidTransitionError. */
describe('AI_PROPOSAL_TRANSITIONS', () => {
  const ALL = Object.values(AiProposalStatus);

  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(AI_PROPOSAL_TRANSITIONS, ALL);
  });

  it('lists exactly the six documented edges', () => {
    const edges = ALL.flatMap((from) => AI_PROPOSAL_TRANSITIONS[from].map((to) => `${from}->${to}`)).sort();
    expect(edges).toEqual(
      ['APPROVED->EXECUTED', 'APPROVED->FAILED', 'PENDING->APPROVED', 'PENDING->EXPIRED', 'PENDING->FAILED', 'PENDING->REJECTED'].sort(),
    );
  });

  it('every unlisted edge throws InvalidTransitionError (incl. APPROVED→PENDING, PENDING→EXECUTED, self-loops)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (AI_PROPOSAL_TRANSITIONS[from].includes(to)) continue;
        expect(() => assertTransition(AI_PROPOSAL_TRANSITIONS, from, to)).toThrow(InvalidTransitionError);
      }
    }
    expect(() => assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.APPROVED, AiProposalStatus.PENDING)).toThrow(InvalidTransitionError);
    expect(() => assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, AiProposalStatus.EXECUTED)).toThrow(InvalidTransitionError);
  });

  it('terminal states never move again (a proposal executes at most once)', () => {
    expect([...AI_TERMINAL_PROPOSAL_STATUSES].sort()).toEqual(['EXECUTED', 'EXPIRED', 'FAILED', 'REJECTED']);
    for (const from of AI_TERMINAL_PROPOSAL_STATUSES) {
      expect(AI_PROPOSAL_TRANSITIONS[from]).toEqual([]);
      for (const to of ALL) expect(() => assertTransition(AI_PROPOSAL_TRANSITIONS, from, to)).toThrow(InvalidTransitionError);
    }
  });

  it('refuses an unknown state (fail closed)', () => {
    expect(() => assertTransition(AI_PROPOSAL_TRANSITIONS, 'DRAFT' as never, AiProposalStatus.APPROVED)).toThrow(InvalidTransitionError);
    expect(() => assertTransition(AI_PROPOSAL_TRANSITIONS, AiProposalStatus.PENDING, 'DONE' as never)).toThrow(InvalidTransitionError);
  });
});
