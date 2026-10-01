/**
 * MUST be the first import of the email-reliability spec — `AppModule`'s
 * `ConfigModule.forRoot` freezes the environment at IMPORT time. A dedicated
 * Redis DB index (9 — `lifecycle-env.ts` already claims 8) so this suite's
 * own BullMQ traffic can never be seen by, or interfere with, the real
 * `rab-email` queue any other locally-running worker/server container might
 * be actively processing on the shared dev Redis.
 */
const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/9`;
process.env.EMAIL_DRIVER = 'LOGGER';
