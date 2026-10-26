/**
 * Side-effect module for the Phase 6a agents suite ONLY: import it right after `./ai-env` and before anything that loads
 * AppModule (ConfigModule validates the environment when it is first loaded). It turns the agents STORAGE API on for
 * this one test process so the CRUD can be exercised; the default stays `false` everywhere else (env default, every other
 * suite, `.env.example`, production). Execution stays off regardless: no trigger can be enabled (EX-3 not approved).
 * The suite also proves the off state by overriding `EnvironmentService.get('AI_AGENTS_ENABLED')` back to false.
 */
process.env.AI_AGENTS_ENABLED = 'true';

export {};
