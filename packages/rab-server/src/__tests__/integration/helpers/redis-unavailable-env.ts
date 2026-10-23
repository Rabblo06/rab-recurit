/**
 * Side-effect module: import it FIRST in a spec file (before AppModule) to boot the API with Redis unreachable (a closed
 * local port) and the Redis-backed core entity cache switched ON. AppModule's ConfigModule validates the environment when
 * it is first loaded, so this must run before that import.
 */
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.CORE_ENTITY_CACHE_ENABLED = 'true';

export {};
