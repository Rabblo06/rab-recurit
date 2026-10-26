/**
 * Side-effect module: import it FIRST in an AI spec (before AppModule — ConfigModule validates the environment when it is
 * first loaded). Turns the platform AI kill switch ON; the model comes from the TEST catalogue the AI test kit injects
 * (src/__tests__/support/ai/test-catalogue.ts, honoured only when NODE_ENV=test) — there is no AI_PROVIDER/AI_MODEL any
 * more (PHASE1_TWENTY_PLAN §5). Every organisation's own AI switch still defaults OFF, so each suite enables exactly the
 * organisations it means to.
 */
process.env.AI_ENABLED = 'true';
// '' (not delete): a present-but-empty variable is "unset" for validation and is never overridden by a local `.env`.
for (const retired of ['AI_PROVIDER', 'AI_MODEL', 'AI_PROVIDER_API_KEY']) process.env[retired] = '';
process.env.AI_TURN_TIMEOUT_SECONDS = process.env.AI_TURN_TIMEOUT_SECONDS ?? '10';
// Suites ask many questions as one user/organisation; the limit suite imports ai-env-limits first to pin the real values.
process.env.AI_USER_RATE_PER_MIN = process.env.AI_USER_RATE_PER_MIN ?? '60';
// 7b: the organisation-per-minute and user-per-day buckets likewise (the limit suite proves the owner's values directly).
process.env.AI_ORG_RATE_PER_MIN = process.env.AI_ORG_RATE_PER_MIN ?? '600';
process.env.AI_USER_TURNS_PER_DAY = process.env.AI_USER_TURNS_PER_DAY ?? '10000';
process.env.AI_ORG_MAX_ACTIVE_TURNS = process.env.AI_ORG_MAX_ACTIVE_TURNS ?? '10';

export {};
