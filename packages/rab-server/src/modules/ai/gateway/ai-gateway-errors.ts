/**
 * Thrown whenever a model cannot be built: not in the catalogue, not ready, not permitted for this turn, no key, an SDK
 * that refused its options. Carries a FIXED message only — never a key, an endpoint, a provider message or a prompt.
 */
export class AiModelNotConfiguredError extends Error {
  constructor() {
    super('No usable AI model is configured');
    this.name = 'AiModelNotConfiguredError';
  }
}

/** Thrown from the per-step hook to stop a turn BEFORE the next model call (budget, kill switch, access). */
export class AiStepRefusedError extends Error {
  /**
   * `content_refused`: the owner-approved Part A exception's checks refused a real-provider request (organisation no
   * longer verifiably synthetic, or the outgoing payload carries a sensitive category). `categories` are fixed category
   * or reason codes only — never the matched text.
   */
  constructor(
    readonly reason: 'budget' | 'meter_unavailable' | 'access_revoked' | 'not_ready' | 'content_refused',
    readonly categories: readonly string[] = [],
  ) {
    super(`AI step refused (${reason})`);
    this.name = 'AiStepRefusedError';
  }
}
