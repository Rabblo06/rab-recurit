/**
 * Side-effect module for the AI limits suite: small, real limits pinned BEFORE ai-env's defaults apply (import this
 * first). Reservation per turn = 8 × (1500 + 4000) = 44 000 tokens, so a 100 000 budget admits exactly two.
 */
process.env.AI_USER_RATE_PER_MIN = '3';
process.env.AI_ORG_MAX_ACTIVE_TURNS = '2';
process.env.AI_ORG_DAILY_TOKEN_BUDGET = '100000';

import './ai-env';

export {};
