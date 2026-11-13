import { randomBytes } from 'node:crypto';

/**
 * Phase X J1b integration suite: imported FIRST (the env is frozen when AppModule is imported). The API's statement
 * dispatcher wake is active only with WORKER_SCHEDULER=bullmq; a random BULLMQ_PREFIX and the suite's own Redis DB index
 * keep its scan-queue keys apart from every other run.
 */
const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/13`;
process.env.WORKER_SCHEDULER = 'bullmq';
process.env.BULLMQ_PREFIX = `crewflow:it-wake-${randomBytes(4).toString('hex')}:bull`;
