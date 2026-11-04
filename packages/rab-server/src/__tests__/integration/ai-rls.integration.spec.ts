import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { AiActionProposalActivate1786720960000 } from '../../database/typeorm/core/migrations/1786720960000-AiActionProposalActivate';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { proposeOk, runningTurn, venueAndRole, windowFromNow } from './helpers/ai-proposal-fixtures';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, manager, newConversation } from './helpers/ai-test-kit';
import { sqlStateAsSchemaRole } from './helpers/schema-role';

/**
 * AI Phase 1 — PostgreSQL isolation (brief §15 "PostgreSQL/RLS"), proven on the REAL runtime role crewflow_app:
 * zero rows without context, organisation and user isolation (HTTP + raw RLS), forged ids, composite tenant FKs,
 * eligibility WITH CHECK, the platform-admin-only organisation switch, least-privilege grants, and the proposal table — inert in
 * Phase 1, ACTIVE since AiActionProposalActivate1786720960000 (T5-D1: per-command policies, column grants, CHECKs, the
 * transition trigger, no DELETE / TRUNCATE, the refusing down()).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const TABLES = ['ai_conversation', 'ai_message', 'ai_usage_daily', 'ai_action_proposal', 'organisation_ai_setting'];

describeIfDb('AI tables RLS and grants (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let a: Awaited<ReturnType<typeof aiOrganisation>> & { conversationId: string; turnId: string };
  let proposal: { id: string; conversationId: string; turnId: string };
  let b: Awaited<ReturnType<typeof aiOrganisation>>;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    const orgA = await aiOrganisation(kit, 'ai-rls-a');
    const conversationId = await newConversation(kit, orgA.token);
    const turn = await ask(kit, orgA.token, conversationId, 'How many offers are awaiting replies?');
    expect(turn.status).toBe(202);
    a = { ...orgA, conversationId, turnId: turn.turnId };
    b = await aiOrganisation(kit, 'ai-rls-b');
    // ai_usage_daily is written only by the Worker when a turn completes; a fixture row makes the zero-rows check below
    // meaningful on a freshly cloned database too (bootstrap identity, not the code under test).
    await kit.owner.query(`INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, turns) VALUES ($1, current_date, 'rls-fixture', 1) ON CONFLICT DO NOTHING`, [orgA.orgId]);
    // One real PENDING proposal of A's CEO, created through the server side of propose_action.
    const proposalTurn = await runningTurn(kit, orgA.ceo);
    const { venueId, jobRoleId } = await venueAndRole(kit, orgA.ceo);
    proposal = {
      id: await proposeOk(kit, proposalTurn, 'create_draft_shift', { venueId, jobRoleId, ...windowFromNow(), requiredCount: 2 }),
      conversationId: proposalTurn.conversationId,
      turnId: proposalTurn.turnId,
    };
  });
  afterAll(async () => {
    await kit?.close();
  });

  const asTenant = <T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, sql: string, params: unknown[] = []) =>
    tenant.runInTenantContext({ ...ctx, role: '' }, (m) => m.query(sql, params) as Promise<T>);

  it('the runtime connection is crewflow_app (no BYPASSRLS) — the role the API and the Worker step loop use', async () => {
    const [row] = await kit.runtime.query(`SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    // I-class (owner-login architecture, BC-02): the one runtime login is crewflow_owner; NOSUPERUSER / NOBYPASSRLS kept.
    expect(row).toEqual({ u: 'crewflow_owner', bypass: false });
  });

  it('no tenant context bound ⇒ zero rows from every AI table (fail closed), although rows exist', async () => {
    for (const t of TABLES) {
      const [{ total }] = await kit.owner.query(`SELECT count(*)::int AS total FROM core.${t}`);
      expect(total).toBeGreaterThan(0);
      const [{ n }] = await kit.runtime.query(`SELECT count(*)::int AS n FROM core.${t}`);
      expect({ t, n }).toEqual({ t, n: 0 });
    }
  });

  it('organisation B cannot read A’s conversation: HTTP 404 on every route, and RLS returns nothing for B’s context', async () => {
    for (const [method, url] of [
      ['get', `/rest/v1/ai/conversations/${a.conversationId}`],
      ['delete', `/rest/v1/ai/conversations/${a.conversationId}`],
      ['get', `/rest/v1/ai/conversations/${a.conversationId}/stream?turnId=${a.turnId}`],
      ['post', `/rest/v1/ai/conversations/${a.conversationId}/turns/${a.turnId}/cancel`],
      ['post', `/rest/v1/ai/conversations/${a.conversationId}/messages`],
    ] as const) {
      const req = kit.http()[method](url).set(bearer(b.token));
      const res = method === 'post' ? await req.send(url.endsWith('messages') ? { content: 'leak?', clientRequestId: randomUUID() } : {}) : await req;
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
      expect(JSON.stringify(res.body)).not.toContain(a.conversationId);
    }
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(b.token))).body.data).toEqual([]);
    const rows = await asTenant<unknown[]>({ organisationId: b.ceo.organisationId, workspaceId: b.ceo.workspaceId, userId: b.ceo.userId }, `SELECT id FROM core.ai_message WHERE conversation_id = $1`, [a.conversationId]);
    expect(rows).toEqual([]);
    // Forging A's organisation in B's session context does not help either: the user predicate still fails.
    const forged = await asTenant<unknown[]>({ organisationId: a.ceo.organisationId, workspaceId: a.ceo.workspaceId, userId: b.ceo.userId }, `SELECT id FROM core.ai_conversation`);
    expect(forged).toEqual([]);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_conversation WHERE id = $1`, [a.conversationId]))[0].n).toBe(1);
  });

  it('another user of the SAME organisation (the Initial Manager) cannot see the CEO’s conversation', async () => {
    const im = await manager(kit, a.orgId, { initial: true });
    expect((await kit.http().get(`/rest/v1/ai/conversations/${a.conversationId}`).set(bearer(im.token))).status).toBe(404);
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(im.token))).body.data).toEqual([]);
    const rows = await asTenant<unknown[]>({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: im.id.userId }, `SELECT id FROM core.ai_conversation`);
    expect(rows).toEqual([]);
  });

  it('a malformed id is a 404 before any query; a random id is a 404 indistinguishable from a foreign one', async () => {
    expect((await kit.http().get('/rest/v1/ai/conversations/not-a-uuid').set(bearer(a.token))).status).toBe(404);
    const random = await kit.http().get(`/rest/v1/ai/conversations/${randomUUID()}`).set(bearer(a.token));
    const foreign = await kit.http().get(`/rest/v1/ai/conversations/${a.conversationId}`).set(bearer(b.token));
    expect(random.status).toBe(404);
    expect(random.body).toEqual(foreign.body);
  });

  it('composite tenant FKs: a message can never reference another organisation’s or another user’s conversation (even as the owner)', async () => {
    const attempt = (org: string, ws: string, user: string) =>
      kit.owner.query(
        `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, 199, 'user', 'x')`,
        [org, ws, user, a.conversationId],
      );
    await expect(attempt(b.orgId, b.ceo.workspaceId!, b.ceo.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(attempt(a.orgId, a.ceo.workspaceId!, b.ceo.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(attempt(a.orgId, b.ceo.workspaceId!, a.ceo.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(
      kit.owner.query(`INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [a.orgId, b.ceo.workspaceId, a.ceo.userId]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('WITH CHECK: crewflow_app cannot insert a row for another tenant/user, and an ineligible user cannot insert at all', async () => {
    const ctxA = { organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId };
    await expect(asTenant(ctxA, `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [b.orgId, b.ceo.workspaceId, b.ceo.userId])).rejects.toMatchObject({ code: '42501' });
    const other = await manager(kit, a.orgId); // holds ai.use through the manager role, but is not the Initial Manager
    await expect(
      asTenant({ organisationId: a.orgId, workspaceId: other.id.workspaceId, userId: other.id.userId }, `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [a.orgId, other.id.workspaceId, other.id.userId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the organisation AI switch: a tenant (even the CEO) cannot turn it on; only an active platform administrator can (RLS)', async () => {
    const ctxB = { organisationId: b.orgId, workspaceId: b.ceo.workspaceId, userId: b.ceo.userId };
    // TypeORM returns [rows, affected] for an UPDATE: the row is visible to B but the write policy matches nothing.
    await expect(asTenant(ctxB, `UPDATE core.organisation_ai_setting SET enabled = false WHERE organisation_id = $1 RETURNING 1`, [b.orgId])).resolves.toEqual([[], 0]);
    const fresh = await kit.factory.createOrganisation('ai-rls-switch');
    const ceo = await kit.factory.createCeo(fresh, { permissions: 'production' });
    await expect(
      asTenant({ organisationId: fresh.id, workspaceId: ceo.workspaceId, userId: ceo.userId }, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true)`, [fresh.id]),
    ).rejects.toMatchObject({ code: '42501' });
    const admin = await kit.factory.createCeo(await kit.factory.createOrganisation('ai-rls-admin'), { platformAdmin: true });
    await expect(
      asTenant({ organisationId: fresh.id, workspaceId: null, userId: admin.userId }, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true) RETURNING enabled`, [fresh.id]),
    ).resolves.toEqual([{ enabled: true }]);
  });

  // P-class (owner-login architecture): every statement stays refused to the schema role crewflow_app (42501). For the
  // runtime login: the two tenant-column UPDATEs are real changes and the UPDATE grant-parity guards refuse them (42501);
  // the DELETEs change no row (RLS / the DELETE parity guards); TRUNCATE is held through the owner (catalogue AI-1, NEEDS
  // OWNER APPROVAL), asserted from the catalog and never executed.
  it('least privilege: no DELETE on messages/usage, no TRUNCATE, no tenant-column UPDATE (schema role); the runtime login changes nothing', async () => {
    const ctxA = { organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId };
    const updates = [
      `UPDATE core.ai_message SET organisation_id = '${b.orgId}' WHERE conversation_id = '${a.conversationId}'`,
      `UPDATE core.ai_conversation SET user_id = '${b.ceo.userId}' WHERE id = '${a.conversationId}'`,
    ];
    const deletes = [`DELETE FROM core.ai_message WHERE conversation_id = '${a.conversationId}'`, `DELETE FROM core.ai_usage_daily`];
    for (const sql of [...deletes, `TRUNCATE core.ai_conversation`, ...updates]) {
      expect({ sql, code: await sqlStateAsSchemaRole(kit.owner, 'crewflow_app', ctxA, [{ sql }]) }).toEqual({ sql, code: '42501' });
    }
    for (const sql of updates) await expect(asTenant(ctxA, sql)).rejects.toMatchObject({ code: '42501' });
    const counts = () =>
      kit.owner.query(
        `SELECT (SELECT count(*)::int FROM core.ai_message WHERE conversation_id = $1) AS m, (SELECT count(*)::int FROM core.ai_usage_daily WHERE organisation_id = $2) AS d`,
        [a.conversationId, a.orgId],
      );
    const before = await counts();
    expect(before[0].m).toBeGreaterThan(0);
    for (const sql of deletes) await asTenant(ctxA, sql).catch(() => undefined);
    expect(await counts()).toEqual(before);
    const [{ t }] = await kit.owner.query(`SELECT has_table_privilege('crewflow_owner', 'core.ai_conversation', 'TRUNCATE') AS t`);
    expect(t).toBe(true);
  });

  it('the purge function refuses a retention below its 30-day SQL floor and an out-of-range batch (whatever the caller passes)', async () => {
    const ctxA = { organisationId: a.orgId, workspaceId: null, userId: '' };
    for (const interval of ['0', '1 day', '29 days']) {
      await expect(asTenant(ctxA, `SELECT core.ai_purge_expired_conversations(interval '${interval}', 10, false)`)).rejects.toMatchObject({ code: '22023' });
    }
    await expect(asTenant(ctxA, `SELECT core.ai_purge_expired_conversations(interval '90 days', 0, false)`)).rejects.toMatchObject({ code: '22023' });
    await expect(asTenant(ctxA, `SELECT core.ai_purge_expired_conversations(interval '90 days', 1001, false)`)).rejects.toMatchObject({ code: '22023' });
    // No organisation bound ⇒ nothing (0), never "every organisation".
    await expect(kit.runtime.query(`SELECT core.ai_purge_expired_conversations(interval '90 days', 10, false) AS n`)).resolves.toEqual([{ n: 0 }]);
  });

  it('the admin usage function: 42501 for anyone but an active platform administrator (unbound, tenant CEO)', async () => {
    await expect(kit.runtime.query(`SELECT * FROM core.ai_admin_usage_summary(current_date, current_date, 10)`)).rejects.toMatchObject({ code: '42501' });
    await expect(asTenant({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId }, `SELECT * FROM core.ai_admin_usage_summary(current_date, current_date, 10)`)).rejects.toMatchObject({ code: '42501' });
  });

  // ───────────────────────────── T5-D1: ai_action_proposal is ACTIVE (AiActionProposalActivate1786720960000)

  const ctxOfA = () => ({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId });
  const hash = 'a'.repeat(64);
  const insertSql = (o: { ws?: string; user?: string; tool?: string; args?: string; extraCols?: string; extraVals?: string; conv?: string }) =>
    `INSERT INTO core.ai_action_proposal (organisation_id, workspace_id, user_id, conversation_id, turn_id, tool_call_id, tool, arguments, summary, snapshot_hash${o.extraCols ?? ''})
     VALUES ('${a.orgId}', '${o.ws ?? a.ceo.workspaceId}', '${o.user ?? a.ceo.userId}', '${o.conv ?? proposal.conversationId}', '${proposal.turnId}',
             'rls_${randomUUID().slice(0, 8)}', '${o.tool ?? 'add_staff_note'}', '${o.args ?? '{}'}'::jsonb, 'x', '${hash}'${o.extraVals ?? ''})`;

  it('T5-D1 isolation: another organisation or another user of the same organisation reads 0 proposals; approve/reject answer 404', async () => {
    expect(await asTenant<unknown[]>({ organisationId: b.orgId, workspaceId: b.ceo.workspaceId, userId: b.ceo.userId }, `SELECT id FROM core.ai_action_proposal`)).toEqual([]);
    // The organisation's CURRENT Initial Manager (one per organisation: reuse the one an earlier test created, if any).
    const [current] = await kit.owner.query(`SELECT u.email FROM core.manager_profile mp JOIN core."user" u ON u.id = mp.user_id WHERE mp.organisation_id = $1 AND mp.is_initial_manager AND mp.superseded_at IS NULL`, [a.orgId]);
    const im = current
      ? await (async () => {
          const [row] = await kit.owner.query(`SELECT mp.user_id, mp.workspace_id, mp.id FROM core.manager_profile mp JOIN core."user" u ON u.id = mp.user_id WHERE u.email = $1`, [current.email]);
          return { id: { userId: row.user_id as string, workspaceId: row.workspace_id as string }, token: await kit.factory.loginByEmail(current.email) };
        })()
      : await manager(kit, a.orgId, { initial: true });
    expect(await asTenant<unknown[]>({ organisationId: a.orgId, workspaceId: im.id.workspaceId, userId: im.id.userId }, `SELECT id FROM core.ai_action_proposal`)).toEqual([]);
    expect(await asTenant<unknown[]>({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: im.id.userId }, `SELECT id FROM core.ai_action_proposal`)).toEqual([]);
    for (const token of [b.token, im.token]) {
      expect((await kit.http().post(`/rest/v1/ai/proposals/${proposal.id}/approve`).set(bearer(token)).send({})).status).toBe(404);
      expect((await kit.http().post(`/rest/v1/ai/proposals/${proposal.id}/reject`).set(bearer(token)).send({ reason: 'not mine' })).status).toBe(404);
    }
    expect((await asTenant<Array<{ id: string }>>(ctxOfA(), `SELECT id FROM core.ai_action_proposal WHERE id = $1`, [proposal.id])).map((r) => r.id)).toEqual([proposal.id]);
  });

  it('T5-D1 INSERT: an ineligible manager is refused by RLS (42501); status / decided / expiry / id columns are not insertable (42501)', async () => {
    const other = await manager(kit, a.orgId); // holds ai.use, is not the Initial Manager
    await expect(
      asTenant({ organisationId: a.orgId, workspaceId: other.id.workspaceId, userId: other.id.userId }, insertSql({ ws: other.id.workspaceId!, user: other.id.userId, conv: randomUUID() })),
    ).rejects.toMatchObject({ code: '42501' });
    // P-class (owner-login architecture): the schema role crewflow_app is refused every one of these columns by its column
    // INSERT grant (42501). The runtime login is not bound by column grants (no INSERT parity guard): status and decided_by
    // are still refused (the INSERT policy pins status = 'PENDING' AND decided_by IS NULL; a CHECK may answer first, 23514);
    // the others are OWNER-LOGIN DIFFERENCE COLGRANT-1 (NEEDS OWNER APPROVAL) and are only ever tried in a rolled-back
    // transaction.
    for (const [col, val] of [
      ['status', `'APPROVED'`],
      ['decided_by', `'${a.ceo.userId}'`],
      ['expires_at', `now() + interval '1 day'`],
      ['created_at', `now() - interval '1 hour'`],
      ['id', `'${randomUUID()}'`],
      ['final_arguments', `'{}'::jsonb`],
      ['origin', `'agent'`],
    ]) {
      const sql = insertSql({ extraCols: `, ${col}`, extraVals: `, ${val}` });
      expect({ col, code: await sqlStateAsSchemaRole(kit.owner, 'crewflow_app', ctxOfA(), [{ sql }]) }).toEqual({ col, code: '42501' });
      const rollback = new Error('rollback');
      const outcome = await tenant
        .runInTenantContext({ ...ctxOfA(), role: '' }, async (m) => {
          await m.query(sql);
          throw rollback;
        })
        .then(
          () => 'OK',
          (e: unknown) => (e === rollback ? 'OK' : ((e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code ?? 'ERROR')),
        );
      if (col === 'status' || col === 'decided_by') expect({ col, outcome }).not.toEqual({ col, outcome: 'OK' });
    }
  });

  it('T5-D1 CHECKs: a 4th tool, forbidden keys in the arguments and an over-limit count are refused (23514), even for the owner role', async () => {
    await expect(asTenant(ctxOfA(), insertSql({ tool: 'send_offers' }))).rejects.toMatchObject({ code: '23514' });
    for (const key of ['organisationId', 'workspaceId', 'userId', 'status', 'payRatePence', 'chargeRatePence']) {
      await expect(asTenant(ctxOfA(), insertSql({ args: JSON.stringify({ [key]: 'x' }) }))).rejects.toMatchObject({ code: '23514' });
      await expect(kit.owner.query(insertSql({ args: JSON.stringify({ [key]: 'x' }) }))).rejects.toMatchObject({ code: '23514' });
    }
    // More than 10 people affected can never be stored as "normal".
    await expect(asTenant(ctxOfA(), insertSql({ extraCols: ', impact, affected_count', extraVals: `, 'normal', 11` }))).rejects.toMatchObject({ code: '23514' });
  });

  it('T5-D1 UPDATE: identity / content / expiry columns are not updatable (42501); the trigger refuses them even for the owner (23514)', async () => {
    // P-class (owner-login architecture): the schema role crewflow_app has no UPDATE grant on these columns (42501). For the
    // runtime login the property is the state: each attempt is refused (the ai_action_proposal_guard trigger, 23514, or the
    // UPDATE parity guard, 42501) or is a no-op assignment, and the row is byte-identical afterwards.
    const rowOf = async () => (await kit.owner.query(`SELECT row_to_json(p)::text AS r FROM core.ai_action_proposal p WHERE id = $1`, [proposal.id]))[0].r;
    for (const set of [`arguments = '{}'::jsonb`, `tool = 'create_draft_shift'`, `expires_at = now() + interval '1 day'`, `summary = 'y'`, `user_id = '${b.ceo.userId}'`, `snapshot_hash = '${hash}'`]) {
      const sql = `UPDATE core.ai_action_proposal SET ${set} WHERE id = '${proposal.id}'`;
      expect({ set, code: await sqlStateAsSchemaRole(kit.owner, 'crewflow_app', ctxOfA(), [{ sql }]) }).toEqual({ set, code: '42501' });
      const before = await rowOf();
      await asTenant(ctxOfA(), sql).catch(() => undefined);
      expect({ set, row: await rowOf() }).toEqual({ set, row: before });
    }
    for (const set of [`arguments = '{}'::jsonb`, `tool = 'add_staff_note'`, `expires_at = expires_at + interval '1 minute'`, `editable_fields = '{}'`]) {
      await expect(kit.owner.query(`UPDATE core.ai_action_proposal SET ${set} WHERE id = $1`, [proposal.id])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('T5-D1 trigger: a foreign decider, PENDING → EXECUTED, EXPIRED before expiry, APPROVED → PENDING and any move out of a terminal state are refused', async () => {
    const decide = (sql: string) => asTenant(ctxOfA(), sql);
    await expect(decide(`UPDATE core.ai_action_proposal SET status = 'REJECTED', decided_by = '${b.ceo.userId}', decided_at = now() WHERE id = '${proposal.id}'`)).rejects.toMatchObject({ code: '23514' });
    await expect(
      decide(
        `UPDATE core.ai_action_proposal SET status = 'EXECUTED', decided_by = core.current_uid(), decided_at = now(), executed_at = now(), result_entity_type = 'shift', result_entity_id = '${randomUUID()}', final_arguments = '{}' WHERE id = '${proposal.id}'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(decide(`UPDATE core.ai_action_proposal SET status = 'EXPIRED', decided_by = core.current_uid(), decided_at = now() WHERE id = '${proposal.id}'`)).rejects.toMatchObject({ code: '23514' });
    // APPROVED → PENDING inside one transaction (the refusal rolls the approval back too).
    await expect(
      tenant.runInTenantContext({ ...ctxOfA(), role: '' }, async (m) => {
        await m.query(`UPDATE core.ai_action_proposal SET status = 'APPROVED', decided_by = core.current_uid(), decided_at = now(), final_arguments = arguments WHERE id = $1`, [proposal.id]);
        await m.query(`UPDATE core.ai_action_proposal SET status = 'PENDING', decided_by = NULL, decided_at = NULL WHERE id = $1`, [proposal.id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await kit.owner.query(`SELECT status FROM core.ai_action_proposal WHERE id = $1`, [proposal.id]))[0].status).toBe('PENDING');
    await decide(`UPDATE core.ai_action_proposal SET status = 'REJECTED', decided_by = core.current_uid(), decided_at = now(), decision_reason = 'rls probe' WHERE id = '${proposal.id}'`);
    for (const to of ['PENDING', 'APPROVED', 'EXECUTED', 'FAILED', 'EXPIRED']) {
      await expect(kit.owner.query(`UPDATE core.ai_action_proposal SET status = $2 WHERE id = $1`, [proposal.id, to])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('T5-D1 no DELETE, no TRUNCATE for crewflow_app; FORCE RLS and exactly three per-command policies', async () => {
    // P-class (owner-login architecture): the schema role crewflow_app is refused DELETE and TRUNCATE (42501). The runtime
    // login's DELETE leaves the proposal in place (no DELETE policy: RLS filters it; the DELETE parity guard would refuse a
    // visible row); TRUNCATE is held through the owner (catalogue AI-1, NEEDS OWNER APPROVAL), never executed here.
    for (const sql of [`DELETE FROM core.ai_action_proposal WHERE id = '${proposal.id}'`, `TRUNCATE core.ai_action_proposal`]) {
      expect({ sql, code: await sqlStateAsSchemaRole(kit.owner, 'crewflow_app', ctxOfA(), [{ sql }]) }).toEqual({ sql, code: '42501' });
    }
    await asTenant(ctxOfA(), `DELETE FROM core.ai_action_proposal WHERE id = '${proposal.id}'`).catch(() => undefined);
    expect(await kit.owner.query(`SELECT 1 FROM core.ai_action_proposal WHERE id = $1`, [proposal.id])).toHaveLength(1);
    const [{ t }] = await kit.owner.query(`SELECT has_table_privilege('crewflow_owner', 'core.ai_action_proposal', 'TRUNCATE') AS t`);
    expect(t).toBe(true);
    const [grants] = await kit.owner.query(
      `SELECT has_table_privilege('crewflow_app', 'core.ai_action_proposal', 'DELETE') AS del, has_table_privilege('crewflow_app', 'core.ai_action_proposal', 'TRUNCATE') AS trunc,
              (SELECT array_agg(cmd::text ORDER BY cmd) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'ai_action_proposal') AS policies,
              (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'core.ai_action_proposal'::regclass) AS forced`,
    );
    expect(grants).toEqual({ del: false, trunc: false, policies: ['INSERT', 'SELECT', 'UPDATE'], forced: true });
  });

  it('T5-D1 M1 down() refuses while a proposal is PENDING (run in a rolled-back transaction on this database)', async () => {
    const turn = await runningTurn(kit, a.ceo);
    const { venueId, jobRoleId } = await venueAndRole(kit, a.ceo);
    await proposeOk(kit, turn, 'create_draft_shift', { venueId, jobRoleId, ...windowFromNow(), requiredCount: 1 });
    const runner = kit.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await expect(new AiActionProposalActivate1786720960000().down(runner)).rejects.toThrow(/PENDING or APPROVED proposals exist/);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ai_action_proposal_guard'`))[0].n).toBe(1);
  });
});
