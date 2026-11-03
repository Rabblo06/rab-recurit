import { bullmqJobOptionsOf, BullmqJobOptions, JobNameOf, QueueName, QueueSettingsOf, queueSettingsOf, ScanQueueName } from './queue-registry';

/**
 * Phase D-Q1: the ONE way a Crewflow producer builds a BullMQ job. Pure (no Nest, no Redis, no BullMQ runtime import).
 *
 * Every enqueue DECLARES WHOSE JOB IT IS — a required tenant scope, checked against the queue registry:
 *   - `{ kind: 'organisation', organisationId }` for the four consumer queues. `organisationId` must be a UUID and must
 *     equal the payload's `organisationId`. It is always taken from a committed row or the server-side tenant context
 *     (the outbox row the producer just wrote or claimed, the bound AuthContext), never from a client value — the
 *     consumer then binds exactly this id with SET LOCAL and re-reads the row under FORCE RLS, so a mismatch could only
 *     ever make the job find nothing.
 *   - `{ kind: 'system' }` for the scan queues (no tenant data at all; the payload must not name an organisation).
 * A missing, malformed or wrong-kind scope, an unknown queue or job name, an unknown payload key or a non-identifier value
 * (object, array, long string, ...) is REFUSED with QueueEnqueueRefusedError before anything reaches Redis (fail closed).
 *
 * The job options are the registry's, so no producer can drift from the pinned values. The jobId is the caller's and is
 * passed through unchanged (deterministic ids: email-outbox.<id>.attempt.<gen>, push-delivery.<id>.attempt.<gen>,
 * shift-statement.<id>.gen.<g>, ai-turn.<id>[.w<n>|.next], ai-title.<conversationId>).
 */
export type JobTenantScope = { readonly kind: 'system' } | { readonly kind: 'organisation'; readonly organisationId: string };

/** The scope type a queue requires, from its registry entry (compile-time: an organisation queue cannot take `system`). */
export type TenantScopeOf<N extends QueueName> = QueueSettingsOf<N>['tenantScope'] extends 'organisation'
  ? { readonly kind: 'organisation'; readonly organisationId: string }
  : { readonly kind: 'system' };

export class QueueEnqueueRefusedError extends Error {
  constructor(queue: string, reason: string) {
    // The reason names a rule, never a payload value.
    super(`enqueue on ${queue} refused: ${reason}`);
    this.name = 'QueueEnqueueRefusedError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An identifier or a short scalar (`v`, `kind`, `cause`, `generation`); never content. */
const MAX_PAYLOAD_STRING = 128;

export interface RegisteredJob<N extends QueueName = QueueName, D = Record<string, unknown>> {
  readonly queue: N;
  readonly name: JobNameOf<N>;
  readonly data: D;
  readonly opts: BullmqJobOptions & { jobId: string; delay?: number };
}

/** Validates a scope against the queue's declared tenant scope. Throws QueueEnqueueRefusedError (fail closed). */
export function assertTenantScope(queue: string, scope: unknown): JobTenantScope {
  const settings = queueSettingsOf(queue);
  if (!scope || typeof scope !== 'object') throw new QueueEnqueueRefusedError(queue, 'a tenant scope is required');
  const s = scope as { kind?: unknown; organisationId?: unknown };
  if (s.kind === 'system') {
    if (Object.keys(s).length !== 1) throw new QueueEnqueueRefusedError(queue, 'a system scope carries no other field');
  } else if (s.kind === 'organisation') {
    if (typeof s.organisationId !== 'string' || !UUID.test(s.organisationId)) throw new QueueEnqueueRefusedError(queue, 'an organisation scope needs a UUID organisationId');
    if (Object.keys(s).length !== 2) throw new QueueEnqueueRefusedError(queue, 'an organisation scope carries only organisationId');
  } else {
    throw new QueueEnqueueRefusedError(queue, 'the tenant scope kind must be system or organisation');
  }
  if (s.kind !== settings.tenantScope) throw new QueueEnqueueRefusedError(queue, `this queue requires a ${settings.tenantScope} scope`);
  return s as JobTenantScope;
}

/**
 * Builds (and validates) one job for `queue`: the declared scope, an accepted job name, an ids-only payload whose keys
 * the registry lists, and the registry's job options plus the caller's deterministic jobId (and optional delay).
 */
export function registeredJob<N extends QueueName, D extends object>(
  queue: N,
  name: JobNameOf<N>,
  scope: TenantScopeOf<N>,
  data: D,
  opts: { jobId: string; delayMs?: number },
): RegisteredJob<N, D> {
  assertRegisteredPayload(queue, name, scope, data);
  if (typeof opts?.jobId !== 'string' || !opts.jobId || opts.jobId.length > 200) throw new QueueEnqueueRefusedError(queue, 'a deterministic jobId is required');
  const delay = opts.delayMs && opts.delayMs > 0 ? Math.trunc(opts.delayMs) : undefined;
  return { queue, name, data, opts: { jobId: opts.jobId, ...(delay ? { delay } : {}), ...bullmqJobOptionsOf(queue) } };
}

/**
 * The job template of a scan queue's job scheduler (bullmq scheduler mode): a `system` scope, an accepted scan job name,
 * the metadata-only payload and the registry's scan job options. BullMQ mints the job ids itself (`repeat:<scheduler>:…`).
 */
export function scanJobTemplate<N extends ScanQueueName, D extends object>(
  queue: N,
  name: JobNameOf<N>,
  scope: TenantScopeOf<N>,
  data: D,
): { name: JobNameOf<N>; data: D; opts: BullmqJobOptions } {
  if (queueSettingsOf(queue).kind !== 'scan') throw new QueueEnqueueRefusedError(queue, 'not a scan queue');
  assertRegisteredPayload(queue, name, scope, data);
  return { name, data, opts: bullmqJobOptionsOf(queue) };
}

/** Name, scope and ids-only payload checks shared by every registered job. Throws QueueEnqueueRefusedError. */
function assertRegisteredPayload(queue: QueueName, name: string, scope: unknown, data: unknown): void {
  const settings = queueSettingsOf(queue);
  if (!settings.jobNames.includes(name)) throw new QueueEnqueueRefusedError(queue, 'unknown job name');
  const checked = assertTenantScope(queue, scope);
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
    throw new QueueEnqueueRefusedError(queue, 'the payload must be a plain object');
  }
  const entries = Object.entries(data);
  for (const [key, value] of entries) {
    if (!settings.payloadKeys.includes(key)) throw new QueueEnqueueRefusedError(queue, `payload key ${JSON.stringify(key).slice(0, 40)} is not an identifier this queue carries`);
    const scalar = value === null || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= MAX_PAYLOAD_STRING);
    if (!scalar) throw new QueueEnqueueRefusedError(queue, `payload key ${key} must be an identifier or short scalar`);
  }
  const payloadOrg = (data as { organisationId?: unknown }).organisationId;
  if (checked.kind === 'organisation' ? payloadOrg !== checked.organisationId : payloadOrg !== undefined) {
    throw new QueueEnqueueRefusedError(queue, 'the payload organisationId does not match the declared tenant scope');
  }
}

/** The structural part of a BullMQ `Queue` a producer needs (no runtime import of bullmq here). */
export interface QueueProducerLike<D> {
  readonly name: string;
  add(name: string, data: D, opts: RegisteredJob['opts']): Promise<unknown>;
}

/**
 * Adds a registered job to its queue. Refuses (synchronously, before Redis) a queue object whose name is not the job's
 * queue. Returns the add promise, so callers can wrap it in `boundedPublish` unchanged.
 */
export function enqueueRegisteredJob<N extends QueueName, D extends object>(queue: QueueProducerLike<D>, job: RegisteredJob<N, D>): Promise<unknown> {
  if (queue.name !== job.queue) throw new QueueEnqueueRefusedError(job.queue, `the producer queue is ${JSON.stringify(queue.name).slice(0, 80)}`);
  return queue.add(job.name, job.data, job.opts);
}
