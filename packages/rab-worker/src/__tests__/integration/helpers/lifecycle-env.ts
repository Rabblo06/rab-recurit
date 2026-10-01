/**
 * MUST be the first import of the lifecycle spec. `AppModule`'s
 * `ConfigModule.forRoot` validates and freezes the environment at IMPORT time,
 * so anything set after the spec's imports run is silently ignored (the
 * symptom is jobs landing in the shared Redis DB 0 instead of the isolated
 * one). Values are therefore fixed here, before any application module loads.
 *
 * The SMTP sink port is derived from the pid because it has to be known
 * synchronously, before the sink can bind.
 */
const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/8`;

export const LIFECYCLE_SMTP_PORT = 20000 + (process.pid % 20000);

process.env.EMAIL_DRIVER = 'SMTP';
process.env.EMAIL_SMTP_HOST = '127.0.0.1';
process.env.EMAIL_SMTP_PORT = String(LIFECYCLE_SMTP_PORT);
process.env.EMAIL_SMTP_NO_TLS = 'true';
process.env.EMAIL_FROM_ADDRESS = 'noreply@rab.test';
delete process.env.EMAIL_SMTP_USER;
delete process.env.EMAIL_SMTP_PASSWORD;
