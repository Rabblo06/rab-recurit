import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { PROCESS_JOB_METADATA, PROCESSOR_QUEUE_METADATA } from './decorators';
import { CONSUMER_QUEUES, consumerQueueByName, isScanQueue } from './queue-registry';
import { SCAN_JOBS, ScanJobDefinition, schedulerIdOf } from './scan-jobs';

/** A startup-refusing registration problem (duplicate handler, scheduled job without handler, unknown queue, ...). */
export class ProcessorRegistrationError extends Error {
  constructor(readonly problems: string[]) {
    super(`worker processor registration refused:\n - ${problems.join('\n - ')}`);
    this.name = 'ProcessorRegistrationError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProcessHandler = (...args: any[]) => Promise<unknown>;

export interface DiscoveredHandler {
  queue: string;
  jobName: string;
  /** `<ProviderClass>.<method>` — for error messages only. */
  source: string;
  handler: ProcessHandler;
}

export interface HandlerRegistry {
  /** `<queue>\u0000<jobName>` → handler. */
  readonly handlers: ReadonlyMap<string, DiscoveredHandler>;
  get(queue: string, jobName: string): DiscoveredHandler | undefined;
  /** The handler for a scan job (exists for every SCAN_JOBS entry once `validateHandlerRegistry` passed). */
  scan(def: ScanJobDefinition): ProcessHandler;
}

const keyOf = (queue: string, jobName: string) => `${queue}\u0000${jobName}`;

/**
 * Finds every `@Processor` provider's `@Process` methods through Nest's own DiscoveryService (no extra dependency) and
 * builds the handler map. Discovery itself already refuses duplicates and unknown queues; `validateHandlerRegistry` then
 * checks coverage against the typed registries. Both run before any queue, scheduler or consumer is created, so a bad
 * registration can never half-start the worker.
 */
@Injectable()
export class ProcessorExplorer {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  explore(): HandlerRegistry {
    const found: DiscoveredHandler[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype || typeof metatype !== 'function') continue;
      const queue: unknown = Reflect.getMetadata(PROCESSOR_QUEUE_METADATA, metatype);
      if (queue === undefined) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const fn = (prototype as Record<string, unknown>)[method];
        if (typeof fn !== 'function') continue;
        const jobName: unknown = Reflect.getMetadata(PROCESS_JOB_METADATA, fn);
        if (jobName === undefined) continue;
        found.push({
          queue: String(queue),
          jobName: String(jobName),
          source: `${metatype.name}.${method}`,
          handler: (fn as ProcessHandler).bind(instance),
        });
      }
    }
    return buildHandlerRegistry(found);
  }
}

/** Pure: duplicate and unknown-queue checks. Exported for unit tests. */
export function buildHandlerRegistry(found: readonly DiscoveredHandler[]): HandlerRegistry {
  const problems: string[] = [];
  const handlers = new Map<string, DiscoveredHandler>();
  for (const h of found) {
    if (!isScanQueue(h.queue) && !consumerQueueByName(h.queue)) {
      problems.push(`${h.source}: @Processor("${h.queue}") is not a queue in the typed queue registry`);
      continue;
    }
    const key = keyOf(h.queue, h.jobName);
    const existing = handlers.get(key);
    if (existing) {
      problems.push(`duplicate handler for ${h.queue}/${h.jobName}: ${existing.source} and ${h.source}`);
      continue;
    }
    handlers.set(key, h);
  }
  if (problems.length) throw new ProcessorRegistrationError(problems);
  return {
    handlers,
    get: (queue, jobName) => handlers.get(keyOf(queue, jobName)),
    scan: (def) => {
      const h = handlers.get(keyOf(def.queue, def.jobName));
      if (!h) throw new ProcessorRegistrationError([`scheduled job ${schedulerIdOf(def)} has no @Process handler`]);
      return h.handler;
    },
  };
}

/**
 * Coverage: every scheduled scan has exactly one handler, every consumer queue has a handler for its one job name, and
 * no handler exists for a job nothing schedules or publishes (an orphan handler is a registration mistake, not a no-op).
 */
export function validateHandlerRegistry(registry: HandlerRegistry, scanJobs: readonly ScanJobDefinition[] = SCAN_JOBS): void {
  const problems: string[] = [];
  const expected = new Set<string>();
  const ids = new Set<string>();
  for (const def of scanJobs) {
    const id = schedulerIdOf(def);
    if (ids.has(id)) problems.push(`scheduler id ${id} is declared twice`);
    ids.add(id);
    expected.add(keyOf(def.queue, def.jobName));
    if (!registry.get(def.queue, def.jobName)) problems.push(`scheduled job ${id} has no @Process handler`);
  }
  for (const q of Object.values(CONSUMER_QUEUES)) {
    expected.add(keyOf(q.name, q.jobName));
    if (!registry.get(q.name, q.jobName)) problems.push(`consumer queue ${q.name} has no @Process("${q.jobName}") handler`);
  }
  for (const [key, h] of registry.handlers) {
    if (!expected.has(key)) problems.push(`${h.source}: @Process("${h.jobName}") on ${h.queue} handles a job nothing schedules or publishes`);
  }
  if (problems.length) throw new ProcessorRegistrationError(problems);
}
