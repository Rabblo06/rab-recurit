import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { AI_WRITE_TOOL_NAMES } from '@rab/shared';

import { buildRegistry } from '../support/ai/tool-fakes';

/**
 * AI 5b static proof: NO tool path can write without an APPROVED proposal.
 *   1. `apply(` of a write tool is called in exactly ONE production file, the proposal executor;
 *   2. `executeApproved(` (the executor) is called only from the proposal service's approve path;
 *   3. the registry, the turn runner, the gateway and the skills never import the executor;
 *   4. the SDK tools the model can be offered never include a write tool's name — even with every write tool permitted,
 *      only `propose_action` (which writes nothing but a PENDING proposal) appears.
 */
const AI_ROOT = join(__dirname, '..', '..', 'modules', 'ai');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') sources(path, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

describe('AI 5b: no write without an approved proposal (static)', () => {
  const files = sources(AI_ROOT).map((p) => ({ rel: relative(AI_ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

  it('apply() of a write tool is called only by the proposal executor', () => {
    const callers = files.filter((f) => /\btool\.apply\(|\.apply\(m,\s*/.test(f.text)).map((f) => f.rel);
    expect(callers).toEqual(['actions/ai-proposal-executor.service.ts']);
  });

  it('executeApproved() is called only from the proposal service', () => {
    const callers = files.filter((f) => /\.executeApproved\(/.test(f.text)).map((f) => f.rel);
    expect(callers).toEqual(['actions/ai-proposal.service.ts']);
  });

  it('the registry, the runner, the gateway and the skills never import the executor', () => {
    for (const f of files.filter((x) => /^(tools|gateway|skills|prompt)\//.test(x.rel) || x.rel === 'services/ai-turn-runner.service.ts')) {
      expect({ file: f.rel, imports: /ai-proposal-executor/.test(f.text) }).toEqual({ file: f.rel, imports: false });
    }
  });

  it('the SDK tools never include a write tool, even with every write tool permitted', () => {
    const { registry } = buildRegistry();
    const sdk = Object.keys(registry.sdkToolDefinitions([...AI_WRITE_TOOL_NAMES]));
    for (const write of AI_WRITE_TOOL_NAMES) expect(sdk).not.toContain(write);
    expect(sdk).toContain('propose_action');
    expect(Object.keys(registry.sdkToolDefinitions([]))).not.toContain('propose_action');
  });
});
