import { AI_PROPOSAL_LIMITS, AiProposalImpact } from '@rab/shared';

/**
 * Impact of a proposal (security rule 6.4, PHASE5_TWENTY_PLAN §2.3, D3). Pure. HIGH when it touches pay, deletes records,
 * or affects more than `AI_PROPOSAL_LIMITS.highImpactAboveAffected` (10) people; high needs a recent step-up and a reason
 * to approve. A proposal affecting more than the per-action cap (`maxRequiredCount`, 25) is refused outright, as is a
 * count that is not a whole number (fail closed). The first write tools never touch pay or delete (their `AiPrepared`
 * types those as the literal `false`), so today only a draft for 11–25 people is high impact.
 */
export function assessImpact(input: { affectedCount: number; touchesPay: boolean; deletes: boolean }): AiProposalImpact {
  const { affectedCount } = input;
  if (!Number.isInteger(affectedCount) || affectedCount < 0) throw new RangeError('assessImpact: affectedCount must be a whole number ≥ 0');
  if (affectedCount > AI_PROPOSAL_LIMITS.maxRequiredCount) throw new RangeError(`assessImpact: more than ${AI_PROPOSAL_LIMITS.maxRequiredCount} people is over the per-action cap`);
  if (input.touchesPay || input.deletes) return 'high';
  return affectedCount > AI_PROPOSAL_LIMITS.highImpactAboveAffected ? 'high' : 'normal';
}

/** The stricter of two impacts (an edit can raise a proposal's impact, never lower what was stored). */
export function maxImpact(a: AiProposalImpact, b: AiProposalImpact): AiProposalImpact {
  return a === 'high' || b === 'high' ? 'high' : 'normal';
}
