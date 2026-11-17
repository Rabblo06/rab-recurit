import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SF-5 (docs/plans/untangle/server-modules.md §3, M15): the layer-5 (per-recipient) predicate on `core.notification`.
 *
 * Before: one policy, `notification_tenant`, FOR ALL, `organisation_id = core.current_org()` (OfferBatchNotificationSchema
 * 1786666300000), unchanged by every later migration. Any statement in the organisation's context could read, update or
 * delete any member's notifications (titles and messages carry names, venues and pay amounts, e.g. the shift statement's
 * "approved gross"); the `user_id = caller` rule lived only in NotificationService. That migration's reason ("the
 * tenant-context session never sets a per-user variable") is stale: `core.current_uid()` (rab.user_id) is bound for every
 * request and used by other policies.
 *
 * After (FORCE kept; every predicate is NULL with no tenant context bound ⇒ zero rows, fail closed):
 *   INSERT  WITH CHECK  organisation_id = current_org()                         notify() writes rows FOR other users, and
 *                                                                               worker jobs have no uid; unchanged.
 *   SELECT  USING       organisation_id = current_org() AND user_id = current_uid()   the recipient only;
 *   SELECT  USING       organisation_id = current_org() AND rab.actor_type = 'worker' the server-set worker marker (push
 *                                                                               send, the shift-statement probe), the same
 *                                                                               marker staff_profile_worker_scan trusts;
 *   SELECT  USING       organisation_id = current_org() AND type = 'offer_sent' AND current_user = 'crewflow'
 *                       AND rab.offer_read_receipt = 'on'                       only inside the definer below;
 *   UPDATE  USING + WITH CHECK  organisation_id = current_org() AND user_id = current_uid()   mark read: recipient only,
 *                                                                               and a row can never be handed to someone else;
 *   DELETE  no policy ⇒ denied for the runtime role (no application path deletes notifications; user/organisation erasure
 *           removes them through the ON DELETE CASCADE foreign keys, which RLS does not apply to).
 *
 * `core.offer_sent_notification_read_at(offer_id, recipient_user_id)`: the venue offer pipeline shows "seen" when the staff
 * member has read the offer's notification (venue-offer-pipeline.service.ts). That is a read of ANOTHER user's row, so it
 * moves into this narrow SECURITY DEFINER function: owned by `crewflow` (the table owner, still bound by FORCE), search_path
 * pinned, the flag set transaction-locally around its one SELECT and cleared after it (a function-level SET of a custom
 * parameter needs a privilege the owner login does not hold; a flag left on by an error is inert, because the policy also
 * requires current_user = 'crewflow', which crewflow_app never is), the bound organisation only,
 * `offer_sent` rows only, and it returns one timestamp — never a title, a message or an id. EXECUTE for `crewflow_app` only.
 *
 * Post-condition (refuses to record the migration on drift): ENABLE + FORCE, exactly these five policies, the function's
 * definer / owner / search_path / EXECUTE, and `crewflow_app` without BYPASSRLS.
 *
 * NEW SQL — owner review required before merge (M15 / SF-5). Not production-approved (N1, production-migration-approval.ts).
 */
const TABLE = 'core.notification';
const READ_AT_FN = 'core.offer_sent_notification_read_at(uuid,uuid)';
const ORG = `organisation_id = core.current_org()`;
const RECIPIENT = `${ORG} AND user_id = core.current_uid()`;

export class NotificationRecipientRls1786721590000 implements MigrationInterface {
  name = 'NotificationRecipientRls1786721590000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP POLICY notification_tenant ON ${TABLE};`);
    await runner.query(`CREATE POLICY notification_insert ON ${TABLE} FOR INSERT WITH CHECK (${ORG});`);
    await runner.query(`CREATE POLICY notification_select_recipient ON ${TABLE} FOR SELECT USING (${RECIPIENT});`);
    await runner.query(`CREATE POLICY notification_select_worker ON ${TABLE} FOR SELECT USING (${ORG} AND current_setting('rab.actor_type', true) = 'worker');`);
    await runner.query(
      `CREATE POLICY notification_select_offer_read_receipt ON ${TABLE} FOR SELECT USING (${ORG} AND type = 'offer_sent' AND current_user = 'crewflow' AND current_setting('rab.offer_read_receipt', true) = 'on');`,
    );
    await runner.query(`CREATE POLICY notification_update_recipient ON ${TABLE} FOR UPDATE USING (${RECIPIENT}) WITH CHECK (${RECIPIENT});`);

    await runner.query(`
      CREATE FUNCTION core.offer_sent_notification_read_at(p_offer_id uuid, p_recipient_user_id uuid)
      RETURNS timestamptz
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_read_at timestamptz;
      BEGIN
        PERFORM pg_catalog.set_config('rab.offer_read_receipt', 'on', true);
        SELECT max(n.read_at) INTO v_read_at
          FROM core.notification n
         WHERE n.organisation_id = core.current_org()
           AND n.type = 'offer_sent'
           AND n.related_entity_id = p_offer_id
           AND n.user_id = p_recipient_user_id;
        PERFORM pg_catalog.set_config('rab.offer_read_receipt', '', true);
        RETURN v_read_at;
      END;
      $fn$;
    `);
    await runner.query(`ALTER FUNCTION ${READ_AT_FN} OWNER TO crewflow;`);
    await runner.query(`REVOKE ALL ON FUNCTION ${READ_AT_FN} FROM PUBLIC;`);
    await runner.query(`GRANT EXECUTE ON FUNCTION ${READ_AT_FN} TO crewflow_app;`);

    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = '${TABLE}'::regclass) AS forced,
         (SELECT array_agg(p.polname::text ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = '${TABLE}'::regclass) AS policies,
         (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'crewflow' AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
            FROM pg_proc p WHERE p.oid = '${READ_AT_FN}'::regprocedure) AS fn_definer_ok,
         has_function_privilege('crewflow_app', '${READ_AT_FN}', 'EXECUTE') AS fn_app_execute,
         EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = '${READ_AT_FN}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS fn_public_execute,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<{ forced: boolean; policies: string[]; fn_definer_ok: boolean; fn_app_execute: boolean; fn_public_execute: boolean; app_bypass: boolean }>;
    const expected = ['notification_insert', 'notification_select_offer_read_receipt', 'notification_select_recipient', 'notification_select_worker', 'notification_update_recipient'];
    if (
      check.forced !== true || JSON.stringify(check.policies) !== JSON.stringify(expected) ||
      check.fn_definer_ok !== true || check.fn_app_execute !== true || check.fn_public_execute || check.app_bypass
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP FUNCTION IF EXISTS ${READ_AT_FN};`);
    for (const policy of ['notification_insert', 'notification_select_recipient', 'notification_select_worker', 'notification_select_offer_read_receipt', 'notification_update_recipient']) {
      await runner.query(`DROP POLICY IF EXISTS ${policy} ON ${TABLE};`);
    }
    await runner.query(`CREATE POLICY notification_tenant ON ${TABLE} USING (${ORG}) WITH CHECK (${ORG});`);
  }
}
