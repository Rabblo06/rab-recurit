import 'reflect-metadata';

import * as fs from 'fs';
import * as path from 'path';

import { MODULE_METADATA } from '@nestjs/common/constants';

import { AiModule } from '../../modules/ai/ai.module';
import { AiWorkerCoreModule } from '../../modules/ai/ai-worker-core.module';
import { AI_LANGUAGE_MODEL_FACTORY, ModelGatewayService } from '../../modules/ai/gateway/model-gateway.service';
import { AiTitleService } from '../../modules/ai/services/ai-title.service';
import { AiTurnRunnerService } from '../../modules/ai/services/ai-turn-runner.service';

/**
 * T2-14 (docs/ai/PHASE2_TWENTY_PLAN.md P2-C11): ONLY the Worker can call a model.
 *
 *   1. The API's AI module graph (`AiModule` and everything it imports, recursively) provides none of the model side:
 *      ModelGatewayService, AI_LANGUAGE_MODEL_FACTORY, AiTurnRunnerService, AiTitleService.
 *   2. `AiWorkerCoreModule` provides them, and the Worker's module imports it; `app.module.ts` never does.
 *   3. No production source outside the Worker module, the gateway and the two Worker services imports the model side
 *      (so a future API service cannot reach a model in-request, bypassing the queue, the slot and the lease).
 * (The provider-SDK boundary and "only the gateway calls streamText" stay in ai-provider-boundary.spec.ts.)
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SERVER_SRC = path.join(REPO_ROOT, 'packages/rab-server/src');
const MODEL_SIDE = [ModelGatewayService, AiTurnRunnerService, AiTitleService] as const;

type Importable = unknown;

/** Every provider token reachable from `root` through `imports` (classes, dynamic modules, forward refs). */
function providerTokens(root: Importable, seen = new Set<unknown>(), tokens = new Set<unknown>()): Set<unknown> {
  let mod = root as Record<string, unknown> | ((...args: unknown[]) => unknown) | undefined;
  if (!mod) return tokens;
  if (typeof (mod as { forwardRef?: () => unknown }).forwardRef === 'function') mod = (mod as { forwardRef: () => unknown }).forwardRef() as typeof mod;
  const isDynamic = typeof mod === 'object' && mod !== null && 'module' in mod;
  const cls = (isDynamic ? (mod as { module: unknown }).module : mod) as object;
  const key = isDynamic ? mod : cls;
  if (!cls || seen.has(key)) return tokens;
  seen.add(key);
  const providers = [...((Reflect.getMetadata(MODULE_METADATA.PROVIDERS, cls) as unknown[]) ?? []), ...((isDynamic ? (mod as { providers?: unknown[] }).providers : []) ?? [])];
  for (const p of providers) tokens.add(typeof p === 'object' && p !== null && 'provide' in p ? (p as { provide: unknown }).provide : p);
  const imports = [...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) as unknown[]) ?? []), ...((isDynamic ? (mod as { imports?: unknown[] }).imports : []) ?? [])];
  for (const i of imports) providerTokens(i, seen, tokens);
  return tokens;
}

function* walk(dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(name)) yield full;
  }
}

describe('AI model side is Worker-only (static)', () => {
  it('the API AiModule graph provides no gateway, model factory, turn runner or title service', () => {
    const tokens = providerTokens(AiModule);
    expect(tokens.size).toBeGreaterThan(10); // a meaningful graph was walked
    for (const t of [...MODEL_SIDE, AI_LANGUAGE_MODEL_FACTORY]) expect(tokens.has(t)).toBe(false);
  });

  it('AiWorkerCoreModule provides all of them', () => {
    const tokens = providerTokens(AiWorkerCoreModule);
    for (const t of [...MODEL_SIDE, AI_LANGUAGE_MODEL_FACTORY]) expect(tokens.has(t)).toBe(true);
  });

  it('the Worker imports AiWorkerCoreModule; app.module.ts never references it', () => {
    const worker = fs.readFileSync(path.join(REPO_ROOT, 'packages/rab-worker/src/worker.module.ts'), 'utf8');
    expect(worker).toMatch(/import \{ AiWorkerCoreModule \} from '@rab\/server\/modules\/ai\/ai-worker-core\.module'/);
    expect(worker).toMatch(/^\s+AiWorkerCoreModule,$/m);
    const app = fs.readFileSync(path.join(SERVER_SRC, 'app.module.ts'), 'utf8');
    expect(app).not.toMatch(/ai-worker-core|AiWorkerCoreModule|ai-turn-runner|ai-title\.service|model-gateway/);
  });

  it('no other production source imports the model side', () => {
    const allowed = new Set([
      'modules/ai/ai-worker-core.module.ts',
      'modules/ai/services/ai-turn-runner.service.ts',
      'modules/ai/services/ai-title.service.ts',
    ]);
    const modelSide = /from\s+['"][^'"]*(ai-worker-core\.module|services\/ai-turn-runner\.service|services\/ai-title\.service|\/ai-turn-runner\.service|\/ai-title\.service|gateway\/model-gateway\.service)['"]/;
    const offenders: string[] = [];
    for (const file of walk(SERVER_SRC)) {
      const rel = path.relative(SERVER_SRC, file).replace(/\\/g, '/');
      if (/(__tests__|\.spec\.ts$|^jest-)/.test(rel) || rel.startsWith('modules/ai/gateway/') || allowed.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      // Type-only imports carry no runtime code (e.g. the AiStepRefusedError type); value imports are what matters.
      for (const line of text.split('\n')) if (modelSide.test(line) && !/^\s*import\s+type\s/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
