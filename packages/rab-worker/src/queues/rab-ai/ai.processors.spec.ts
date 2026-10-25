import { Job } from 'bullmq';

import type { AiTurnJobData } from '@rab/server/engine/worker-shared/ai-queue.constants';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { AI_RETENTION_LOCK, AiMaintenanceProcessor, AiTurnConsumer } from './ai.processors';

jest.mock('../../core/locking/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_ds: unknown, name: string, work: () => Promise<unknown>) => (name === 'locked-elsewhere' ? { acquired: false } : { acquired: true, value: await work() })),
}));

describe('rab-ai processors (unit)', () => {
  it('the consumer hands ONLY the job data (ids) to the shared step loop and returns its outcome', async () => {
    const run = jest.fn().mockResolvedValue('completed');
    const consumer = new AiTurnConsumer({ run } as never);
    const data: AiTurnJobData = { v: 1, turnId: 't', conversationId: 'c', organisationId: 'o', workspaceId: 'w', userId: 'u' };
    await expect(consumer.turn({ data } as Job<AiTurnJobData>)).resolves.toBe('completed');
    expect(run).toHaveBeenCalledWith(data);
  });

  const depsWith = (mode: string) => {
    const deps = new WorkerDependencies();
    deps.provide({ runtimeDataSource: {}, directDataSource: {}, environmentService: { get: () => mode }, logger: { log: jest.fn() } } as never);
    return deps;
  };

  it('retention OFF (default): no lock, no database call, returns false (never stamped as a run)', async () => {
    const runCycle = jest.fn();
    const p = new AiMaintenanceProcessor(depsWith('off'), { runCycle } as never);
    await expect(p.aiRetention()).resolves.toBe(false);
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('retention report/purge runs under the cross-replica advisory lock with the configured mode', async () => {
    const runCycle = jest.fn().mockResolvedValue({ ran: true, mode: 'report', organisations: 2, conversations: 3, truncated: 0 });
    const p = new AiMaintenanceProcessor(depsWith('report'), { runCycle } as never);
    await expect(p.aiRetention()).resolves.toBe(true);
    expect(runCycle).toHaveBeenCalledWith({}, 'report');
    const { withAdvisoryLock } = jest.requireMock('../../core/locking/advisory-lock') as { withAdvisoryLock: jest.Mock };
    expect(withAdvisoryLock.mock.calls[0][1]).toBe(AI_RETENTION_LOCK);
  });
});
