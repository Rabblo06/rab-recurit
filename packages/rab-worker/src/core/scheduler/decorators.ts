import 'reflect-metadata';
import { Injectable } from '@nestjs/common';

/**
 * `@Processor(queue)` / `@Process(jobName)` — the jobs process's own minimal equivalent of `@nestjs/bullmq`'s decorators
 * (deliberately NOT a new dependency: the processor explorer only needs Nest's built-in `DiscoveryService`). A processor
 * is an ordinary Nest provider; each `@Process` method handles exactly one job name on the processor's queue.
 *
 * Supported surface (anything else is a startup failure, see processor-explorer.ts): one queue name from the typed
 * registry per class, one job name per method, string arguments only, no options. Scan handlers receive a
 * `CycleContext` and return `boolean | void` (`false` = do not stamp lastRunAt); consumer handlers receive the BullMQ job.
 */
export const PROCESSOR_QUEUE_METADATA = 'crewflow:worker:processor-queue';
export const PROCESS_JOB_METADATA = 'crewflow:worker:process-job';

export function Processor(queueName: string): ClassDecorator {
  if (typeof queueName !== 'string' || !queueName) throw new Error('@Processor() requires a queue name from the queue registry');
  return (target) => {
    Injectable()(target);
    Reflect.defineMetadata(PROCESSOR_QUEUE_METADATA, queueName, target);
  };
}

export function Process(jobName: string): MethodDecorator {
  if (typeof jobName !== 'string' || !jobName) throw new Error('@Process() requires a job name');
  return (_target, _key, descriptor) => {
    Reflect.defineMetadata(PROCESS_JOB_METADATA, jobName, descriptor.value as object);
    return descriptor;
  };
}
