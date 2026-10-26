import { Job } from 'bullmq';

import type { AiTurnJobData } from '@rab/server/engine/worker-shared/ai-queue.constants';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { AI_RETENTION_LOCK, AiMaintenanceProcessor, AiTurnConsumer, aiJobKind } from './ai.processors';

jest.mock('../../core/locking/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_ds: unknown, name: string, work: () => Promise<unknown>) => (name === 'locked-elsewhere' ? { acquired: false } : { acquired: true, value: await work() })),
}));

const ids = { turnId: 't', conversationId: 'c', organisationId: 'o', workspaceId: 'w', userId: 'u' };
const job = (name: string, data: unknown) => ({ name, data }) as Job<unknown>;

describe('rab-ai processors (unit)', () => {
  const consumer = () => {
    const run = jest.fn().mockResolvedValue('completed');
    const title = jest.fn().mockResolvedValue('written');
    return { c: new AiTurnConsumer({ run } as never, { run: title } as never), run, title };
  };

  it('ai-turn: hands ONLY the job data (ids) to the shared step loop and returns its outcome (v1 and v2)', async () => {
    const { c, run, title } = consumer();
    const v1: AiTurnJobData = { v: 1, ...ids };
    await expect(c.turn(job('ai-turn', v1))).resolves.toBe('completed');
    expect(run).toHaveBeenCalledWith(v1);
    const v2 = { v: 2, kind: 'turn', ...ids };
    await expect(c.turn(job('ai-turn', v2))).resolves.toBe('completed');
    expect(run).toHaveBeenLastCalledWith(v2);
    expect(title).not.toHaveBeenCalled();
  });

  it('ai-title → the title service; `deferred` from the runner is passed through as a normal result', async () => {
    const { c, run, title } = consumer();
    const data = { v: 2, kind: 'title', ...ids };
    await expect(c.turn(job('ai-title', data))).resolves.toBe('written');
    expect(title).toHaveBeenCalledWith(data);
    run.mockResolvedValueOnce('deferred');
    await expect(c.turn(job('ai-turn', { v: 2, kind: 'turn', ...ids }))).resolves.toBe('deferred');
  });

  it('a kind that does not belong to the job name is skipped (fail closed), nothing called', async () => {
    const { c, run, title } = consumer();
    await expect(c.turn(job('ai-turn', { v: 2, kind: 'title', ...ids }))).resolves.toBe('skipped');
    await expect(c.turn(job('ai-title', { v: 2, kind: 'turn', ...ids }))).resolves.toBe('skipped');
    await expect(c.turn(job('ai-title', { v: 1, ...ids }))).resolves.toBe('skipped');
    await expect(c.turn(job('ai-turn', { v: 2 }))).resolves.toBe('skipped');
    await expect(c.turn(job('something-else', { v: 2, kind: 'turn', ...ids }))).resolves.toBe('skipped');
    expect(run).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
  });

  it('resume (Phase 5b) and agent-run (EX-3 not approved) are refused: nothing read, nothing run', async () => {
    const { c, run, title } = consumer();
    await expect(c.turn(job('ai-turn', { v: 2, kind: 'resume', ...ids, pausedTurnId: 'p', cause: 'input_answered', refId: 'r' }))).resolves.toBe('refused');
    await expect(c.turn(job('ai-agent-run', { v: 2, kind: 'agent-run', ...ids, agentId: 'a', triggerId: null }))).resolves.toBe('refused');
    await expect(c.turn(job('ai-agent-run', { v: 2, kind: 'turn', ...ids }))).resolves.toBe('refused');
    expect(run).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
  });

  it('aiJobKind: v1 = turn; v2 kinds; anything else null', () => {
    expect(aiJobKind({ v: 1 })).toBe('turn');
    expect(aiJobKind({ v: 2, kind: 'title' })).toBe('title');
    expect(aiJobKind({ v: 2, kind: 'x' })).toBeNull();
    expect(aiJobKind(null)).toBeNull();
    expect(aiJobKind('ai-turn')).toBeNull();
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
