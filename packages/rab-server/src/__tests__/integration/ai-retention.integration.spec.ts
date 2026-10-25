import './helpers/ai-env';

import { AiRetentionService } from '../../modules/ai/services/ai-retention.service';
import { AiKit, aiOrganisation, ask, bootAiKit, newConversation } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — retention and erasure (brief §4 "Data retention", §15 "Conversation retention"): the purge runs only
 * through `core.ai_purge_expired_conversations`, one organisation at a time, on the runtime role; `report` deletes
 * nothing; `purge` deletes only conversations idle > AI_RETENTION_DAYS (90) of the bound organisation, never one with
 * a queued/running turn; audit history survives; deleting a user erases their AI rows (cascade).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI retention and erasure (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let retention: AiRetentionService;

  beforeAll(async () => {
    kit = await bootAiKit();
    retention = kit.moduleRef.get(AiRetentionService);
  });
  afterAll(async () => {
    await kit?.close();
  });

  async function conversations(label: string) {
    const org = await aiOrganisation(kit, label);
    const old = await newConversation(kit, org.token);
    const recent = await newConversation(kit, org.token);
    const oldButActive = await newConversation(kit, org.token);
    const t = await ask(kit, org.token, oldButActive, 'What is our fill rate?'); // stays queued
    expect(t.status).toBe(202);
    await kit.owner.query(`UPDATE core.ai_conversation SET last_message_at = now() - interval '91 days' WHERE id = ANY($1::uuid[])`, [[old, oldButActive]]);
    await kit.owner.query(`UPDATE core.ai_conversation SET last_message_at = now() - interval '89 days' WHERE id = $1`, [recent]);
    return { org, old, recent, oldButActive };
  }
  const exists = async (id: string) => (await kit.owner.query(`SELECT 1 FROM core.ai_conversation WHERE id = $1`, [id])).length === 1;

  it('mode off does nothing; report counts per organisation and deletes nothing', async () => {
    const a = await conversations('ai-ret-report');
    expect(await retention.runCycle(kit.runtime, 'off')).toMatchObject({ ran: false });
    expect(await retention.purgeOrganisation(a.org.orgId, 'report')).toEqual({ conversations: 1, truncated: false });
    expect(await exists(a.old)).toBe(true);
  });

  it('purge deletes only the bound organisation’s expired, idle conversations (messages cascade); recent / active / other organisations stay; audit history survives', async () => {
    const a = await conversations('ai-ret-a');
    const b = await conversations('ai-ret-b');
    const auditBefore = (await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1`, [a.org.orgId]))[0].n;
    expect(await retention.purgeOrganisation(a.org.orgId, 'purge')).toEqual({ conversations: 1, truncated: false });
    expect(await exists(a.old)).toBe(false);
    expect(await exists(a.recent)).toBe(true);
    expect(await exists(a.oldButActive)).toBe(true);
    expect(await exists(b.old)).toBe(true); // another organisation is never touched
    const purged = await kit.owner.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.retention_purged'`, [a.org.orgId]);
    expect(purged).toEqual([{ actor_user_id: null, metadata: { conversations: 1, retentionDays: 90 } }]);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1`, [a.org.orgId]))[0].n).toBe(auditBefore + 1);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id = $1`, [a.old]))[0].n).toBeGreaterThan(0); // created-audit kept
  });

  it('the scheduled cycle (runtime role, every organisation) purges expired conversations everywhere, one organisation at a time', async () => {
    const c = await conversations('ai-ret-cycle');
    const result = await retention.runCycle(kit.runtime, 'purge');
    expect(result.ran).toBe(true);
    expect(result.organisations).toBeGreaterThan(0);
    expect(result.conversations).toBeGreaterThanOrEqual(1);
    expect(await exists(c.old)).toBe(false);
    expect(await exists(c.recent)).toBe(true);
  });

  it('user erasure: deleting the user removes their conversations and messages (composite FK cascade)', async () => {
    const org = await aiOrganisation(kit, 'ai-ret-erase');
    const id = await newConversation(kit, org.token);
    await kit.owner.query(`DELETE FROM core.ai_conversation WHERE id = $1`, [id]).catch(() => undefined);
    const keep = await newConversation(kit, org.token);
    await ask(kit, org.token, keep, 'hello');
    await kit.owner.query(`DELETE FROM core.refresh_token WHERE user_id = $1`, [org.ceo.userId]);
    await kit.owner.query(`DELETE FROM core.user_session WHERE user_id = $1`, [org.ceo.userId]).catch(() => undefined);
    await kit.owner.query(`DELETE FROM core.manager_workspace WHERE owner_user_id = $1`, [org.ceo.userId]).catch(() => undefined);
    await kit.owner.query(`DELETE FROM core."user" WHERE id = $1`, [org.ceo.userId]);
    for (const t of ['ai_conversation', 'ai_message']) {
      expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.${t} WHERE user_id = $1`, [org.ceo.userId]))[0].n).toBe(0);
    }
  });
});
