/**
 * Side-effect module: import it FIRST in an AI spec (before AppModule — ConfigModule validates the environment when it is
 * first loaded). Turns the platform AI kill switch ON with the deterministic `mock` model; every organisation's own AI
 * switch still defaults OFF, so each suite enables exactly the organisations it means to.
 */
process.env.AI_ENABLED = 'true';
process.env.AI_PROVIDER = 'mock';
process.env.AI_MODEL = 'crewflow-mock-1';
process.env.AI_TURN_TIMEOUT_SECONDS = process.env.AI_TURN_TIMEOUT_SECONDS ?? '10';
// Suites ask many questions as one user/organisation; the limit suite imports ai-env-limits first to pin the real values.
process.env.AI_USER_RATE_PER_MIN = process.env.AI_USER_RATE_PER_MIN ?? '60';
process.env.AI_ORG_MAX_ACTIVE_TURNS = process.env.AI_ORG_MAX_ACTIVE_TURNS ?? '10';
delete process.env.AI_PROVIDER_API_KEY;

export {};
