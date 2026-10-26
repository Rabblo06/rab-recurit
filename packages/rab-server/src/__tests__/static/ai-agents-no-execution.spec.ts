import * as fs from 'fs';
import * as path from 'path';

import { AI_AGENT_EXECUTION_APPROVED } from '../../modules/ai/contracts/agents';

/**
 * Phase 6a — NO EXECUTION PATH EXISTS (owner decision 2026-10-25: EX-3 deferred; docs/ai/PHASE6_TWENTY_PLAN.md §5 / T6-P3).
 * A static scan of the server and Worker sources (there is no ESLint here; "lint" = tsc):
 *   - the EX-3 gate constant is the literal `false`;
 *   - no scan job, processor, queue producer or scheduler names an agent: `ai-agent-run` / AI_AGENT_RUN_JOB_NAME appears
 *     only in the job contract, the server contract types and the Worker processor that REFUSES it; `ai-agent-triggers`,
 *     the `ai_agent_schedule` / `ai_agent_event` due-work kinds and the 6b definers appear nowhere outside migrations;
 *   - the agent code (modules/ai/agents/*, services/ai-agent*.ts, the agents controller and module) never imports the
 *     runner, the turn queue, the gateway / provider factory, BullMQ, the scheduler, `scoped-job` / `runScopedForOrg`,
 *     `directDataSource`, and never sets `actorType` (rule 2.1: an agent never runs in a system context);
 *   - `AiAgentPrincipalService` has no consumer (only its module provides it) and refuses before any read;
 *   - `AiAgentsModule` is imported by the API's AiModule only — never by the Worker graph.
 */
const SERVER_SRC = path.resolve(__dirname, '../..');
const WORKER_SRC = path.resolve(__dirname, '../../../../rab-worker/src');
const AI_DIR = path.join(SERVER_SRC, 'modules/ai');

function sources(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts'))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !/[\\/]__tests__[\\/]/.test(f));
}
const rel = (f: string) => path.relative(path.resolve(SERVER_SRC, '../..'), f).replace(/\\/g, '/');
/** Code only: comments may (and do) explain the rule by naming what is forbidden. */
const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ALL = [...sources(SERVER_SRC), ...sources(WORKER_SRC)];
const NON_MIGRATION = ALL.filter((f) => !/[\\/]migrations[\\/]/.test(f));
const AGENT_CODE = [
  ...sources(path.join(AI_DIR, 'agents')),
  ...fs
    .readdirSync(path.join(AI_DIR, 'services'))
    .filter((n) => /^ai-agent.*\.ts$/.test(n))
    .map((n) => path.join(AI_DIR, 'services', n)),
  path.join(AI_DIR, 'controllers/ai-agent.controller.ts'),
  path.join(AI_DIR, 'controllers/ai-agents-switch.guard.ts'),
  path.join(AI_DIR, 'ai-agents.module.ts'),
];

describe('Phase 6a: no agent execution path exists (static)', () => {
  it('the EX-3 gate is the literal false', () => {
    expect(AI_AGENT_EXECUTION_APPROVED).toBe(false);
    expect(code(path.join(AI_DIR, 'contracts/agents.ts'))).toMatch(/export const AI_AGENT_EXECUTION_APPROVED = false as const;/);
  });

  it('scans the server and the Worker', () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(ALL.some((f) => rel(f).endsWith('rab-worker/src/queues/rab-ai/ai.processors.ts'))).toBe(true);
    expect(AGENT_CODE.map(rel)).toEqual(
      expect.arrayContaining([
        'rab-server/src/modules/ai/services/ai-agent.service.ts',
        'rab-server/src/modules/ai/services/ai-agent-trigger.service.ts',
        'rab-server/src/modules/ai/services/ai-agent-role.service.ts',
        'rab-server/src/modules/ai/services/ai-agent-principal.service.ts',
        'rab-server/src/modules/ai/agents/agent-principal.policy.ts',
      ]),
    );
  });

  it('the agent-run job is named only by its contract and by the Worker processor that refuses it', () => {
    const users = NON_MIGRATION.filter((f) => /AI_AGENT_RUN_JOB_NAME|['"`]ai-agent-run['"`]/.test(code(f))).map(rel).sort();
    expect(users).toEqual(['rab-server/src/engine/worker-shared/ai-jobs.contract.ts', 'rab-worker/src/queues/rab-ai/ai.processors.ts']);
    const processor = code(ALL.find((f) => rel(f).endsWith('rab-worker/src/queues/rab-ai/ai.processors.ts'))!);
    expect(processor).toMatch(/job\.name === AI_AGENT_RUN_JOB_NAME \|\| kind === 'agent-run'[^\n]*return 'refused'/);
  });

  it('no scan job, due-work kind, recorder or pause/purge definer for agents exists outside migrations', () => {
    const patterns: Array<[string, RegExp]> = [
      ['the ai-agent-triggers scan', /ai-agent-triggers/],
      ['the schedule due-work kind', /ai_agent_schedule/],
      ['the event due-work kind', /['"`]ai_agent_event['"`]/],
      ['the event recorder definer', /ai_agent_record_event/],
      ['the pause definer', /ai_agent_trigger_pause/],
      ['the purge definer', /ai_agent_event_purge/],
      ['an INSERT into the event outbox', /INSERT\s+INTO\s+core\.ai_agent_event\b/i],
      ['a due-work pointer for a trigger', /subject_type[^;]{0,200}ai_agent_trigger|ai_agent_trigger[^;]{0,200}worker_due_work/],
    ];
    const hits = NON_MIGRATION.flatMap((f) => patterns.filter(([, re]) => re.test(code(f))).map(([what]) => `${rel(f)}: ${what}`));
    expect(hits).toEqual([]);
  });

  it.each(AGENT_CODE.map((f) => [rel(f), f] as const))('%s never reaches a runner, queue, gateway, scheduler or system context', (_rel, file) => {
    const text = code(file);
    const forbidden: Array<[string, RegExp]> = [
      ['the turn runner', /ai-turn-runner/],
      ['the turn queue', /ai-turn-queue|AiTurnQueueService/],
      ['the model gateway / provider factory', /model-gateway|provider-factory|AI_LANGUAGE_MODEL_FACTORY/],
      ['the AI SDK', /from\s+['"]ai['"]/],
      ['BullMQ / a queue', /@nestjs\/bullmq|from\s+['"]bullmq['"]|InjectQueue|queue-registry|ai-queue\.constants/],
      ['the scheduler', /scan-jobs|scheduler/i],
      ['the worker system context', /scoped-job|runScopedForOrg|actorType|directDataSource/],
      ['the event recorder', /ai-agent-events|AgentEventRecorder/],
      ['a due-work pointer', /worker_due_work|claim_due_work/],
      ['a require() escape hatch', /\brequire\s*\(/],
    ];
    expect(forbidden.filter(([, re]) => re.test(text)).map(([what]) => what)).toEqual([]);
  });

  it('AiAgentPrincipalService has no consumer, and both of its methods refuse on the gate FIRST', () => {
    const consumers = NON_MIGRATION.filter((f) => /\bAiAgentPrincipalService\b/.test(code(f))).map(rel).sort();
    expect(consumers).toEqual(['rab-server/src/modules/ai/ai-agents.module.ts', 'rab-server/src/modules/ai/services/ai-agent-principal.service.ts']);
    const text = code(path.join(AI_DIR, 'services/ai-agent-principal.service.ts'));
    const rebuild = text.slice(text.indexOf('async rebuildForAgentRun('));
    expect(rebuild.split('\n')[1]).toMatch(/if \(!AI_AGENT_EXECUTION_APPROVED\) return \{ refused: true, reason: 'execution_not_approved' \}/);
    const assert = text.slice(text.indexOf('async assertAgentStillAllowed('));
    expect(assert.split('\n')[1]).toMatch(/if \(!AI_AGENT_EXECUTION_APPROVED\) throw new AiAccessRevokedError\('execution_not_approved'\)/);
  });

  it('the trigger service never writes `enabled = true` and its enable() writes nothing', () => {
    const text = code(path.join(AI_DIR, 'services/ai-agent-trigger.service.ts'));
    expect(text).not.toMatch(/enabled\s*=\s*true/i);
    const enable = text.slice(text.indexOf('async enable('), text.indexOf('async disable('));
    expect(enable).not.toMatch(/INSERT|UPDATE|DELETE|authorizeWrite|stepUp/);
    expect(enable).toMatch(/throw new AiAgentExecutionNotApprovedException\(\)/);
  });

  it('AiAgentsModule is imported by the API AiModule only (never the Worker graph)', () => {
    const importers = ALL.filter((f) => /from\s+['"][^'"]*ai-agents\.module['"]/.test(code(f))).map(rel).sort();
    expect(importers).toEqual(['rab-server/src/modules/ai/ai.module.ts']);
    expect(code(path.join(AI_DIR, 'ai-worker-core.module.ts'))).not.toMatch(/AiAgents|ai-agent/);
  });
});
