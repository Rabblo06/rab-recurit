import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { AiToolCallSummary } from '@rab/shared';

import { AI_DEMO_JOB_ROLES, AI_DEMO_VENUES } from '../../command/seed-ai-demo.command';
import { scanOutgoingPayload } from '../../modules/ai/gateway/outgoing-payload-guard';
import { buildSystemPrompt } from '../../modules/ai/prompt/system-prompt';
import { AiAccessService } from '../../modules/ai/services/ai-access.service';
import { AiToolRegistry } from '../../modules/ai/tools/ai-tool-registry.service';
import { AiKit, aiOrganisation, bootAiKit } from './helpers/ai-test-kit';

/**
 * T-P2 (docs/ai/PHASE1_TWENTY_PLAN.md §8/§10.1): the payload the live smoke test will send. The REAL
 * `list_unfilled_shifts` tool runs under RLS on a disposable database seeded like `seed-ai-demo` (its venue and job-role
 * names, ISO times, UUIDs, counts); its output, framed exactly as the model would receive it (tool-call id shaped like
 * Anthropic's `toolu_…`), must scan CLEAN — so the guard will not refuse the smoke test. The same tool output with ONE
 * real-looking value in the data (a postcode in a venue name) is refused. (That a refused request is never SENT — zero
 * provider requests — is proven with a fetch spy in ai-real-provider-gateway.spec.ts; on this test-marked database the
 * real-provider path stops even earlier, at the synthetic re-verification.)
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const H = 3_600_000;

describeIfDb('AI payload guard on real tool output (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterAll(async () => {
    await kit?.close();
  });

  async function seedLikeDemo(label: string, venueNames: readonly string[]) {
    const org = await aiOrganisation(kit, label);
    const ws = org.ceo.workspaceId!;
    const q = (sql: string, params: unknown[]) => kit.owner.query(sql, params);
    const venues: string[] = [];
    for (const name of venueNames) venues.push((await q(`INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [org.orgId, name, org.ceo.userId, ws]))[0].id);
    const roles: string[] = [];
    for (const [name, rate] of AI_DEMO_JOB_ROLES) roles.push((await q(`INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [org.orgId, name, rate, org.ceo.userId, ws]))[0].id);
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      const start = now + (24 + i * 18) * H;
      await q(
        `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, $4, $5, 30, $6, $7, $8, $9, $10, $11)`,
        [org.orgId, venues[i % venues.length], roles[i % roles.length], new Date(start), new Date(start + 8 * H), 3, i % 2, AI_DEMO_JOB_ROLES[i % roles.length]![1], i % 2 ? 'partially_filled' : 'open', org.ceo.userId, ws],
      );
    }
    return org;
  }

  async function payloadFor(org: Awaited<ReturnType<typeof seedLikeDemo>>) {
    const actor = await kit.moduleRef.get(AiAccessService).rebuildForWorker({ organisationId: org.orgId, workspaceId: org.ceo.workspaceId!, userId: org.ceo.userId, sessionId: sidOf(org.token) });
    const run = { actor, turnId: randomUUID(), conversationId: randomUUID(), abortTurn: () => undefined, calls: [] as AiToolCallSummary[] };
    const tool = kit.moduleRef.get(AiToolRegistry).buildToolSet(run).list_unfilled_shifts as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    const input = { from: day(Date.now()), to: day(Date.now() + 9 * 86_400_000) };
    const output = await tool.execute(input, { toolCallId: 'toolu_01HxYz9KqP3mN8wR2tV5bC7d', messages: [] });
    const toolCallId = 'toolu_01HxYz9KqP3mN8wR2tV5bC7d';
    return {
      output,
      payload: {
        system: buildSystemPrompt(day(Date.now())),
        messages: [
          { role: 'user', content: 'Which shifts this weekend are unfilled?' },
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'list_unfilled_shifts', input }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'list_unfilled_shifts', output: { type: 'json', value: output } }] },
        ],
        extraTexts: ['Which shifts this weekend are unfilled?'],
      },
    };
  }

  it('the real tool output on smoke-test-like synthetic data scans clean (the guard will not refuse the smoke test)', async () => {
    const org = await seedLikeDemo('ai-payload-clean', AI_DEMO_VENUES);
    const { output, payload } = await payloadFor(org);
    const data = (output as { data: { unfilledShiftCount: number; shifts: Array<{ venue: string }> } }).data;
    expect(data.unfilledShiftCount).toBeGreaterThan(0);
    expect(data.shifts.map((s) => s.venue)).toEqual(expect.arrayContaining([...AI_DEMO_VENUES]));
    expect(scanOutgoingPayload(payload)).toEqual([]);
  });

  it('the same real tool output with a postcode seeded into a venue name is refused (categories only)', async () => {
    const org = await seedLikeDemo('ai-payload-tainted', ['Synthetic Grand Hall', 'Riverside Bar SW1A 1AA']);
    const { payload } = await payloadFor(org);
    const categories = scanOutgoingPayload(payload);
    expect(categories).toContain('postcode');
    expect(JSON.stringify(categories)).not.toContain('SW1A');
  });
});
