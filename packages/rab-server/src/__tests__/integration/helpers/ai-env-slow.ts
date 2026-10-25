/** Side-effect module: a turn timeout long enough to observe SSE re-validation (10 s) while a turn is still running. */
process.env.AI_TURN_TIMEOUT_SECONDS = '40';

import './ai-env';

export {};
