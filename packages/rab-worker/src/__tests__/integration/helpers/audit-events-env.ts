/**
 * MUST be the first import of the X1.1 audit-events suite: `AppModule`'s ConfigModule freezes the environment at import
 * time, and AuditEventQueueService reads CREWFLOW_AUDIT_SINK when it is constructed. Its own Redis DB index (13; 8–12 are
 * claimed by other suites) so its BullMQ traffic never meets another suite's or a running stack's. The sink is `stdout`
 * (the production mode); the suite replaces the WRITERS with in-memory ones, never the sink logic.
 */
const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/13`;
process.env.CREWFLOW_AUDIT_SINK = 'stdout';
delete process.env.CREWFLOW_AUDIT_SINK_FILE;
delete process.env.CREWFLOW_AUDIT_SINK_FAILURE;
