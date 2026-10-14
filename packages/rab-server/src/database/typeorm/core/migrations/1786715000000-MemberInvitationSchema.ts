import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email-first member invitations (Settings → Members → Invite).
 *
 * WHY A NEW TABLE (not `account_invite`): an `account_invite` row is bound to an EXISTING `core.user`
 * (`user_id NOT NULL`), so every invitation sent through it creates the account first — which is exactly
 * why the old Members form had to ask the administrator for the invitee's first and last name
 * (`user.first_name`/`last_name` are NOT NULL). `member_invitation` records only the pending INTENT
 * (organisation, target workspace UUID, normalised email, server-approved custom role, inviter, token hash,
 * lifecycle timestamps). No `core.user`, profile, role assignment or workspace membership exists until
 * the recipient accepts and supplies their own name and password — then `MemberInvitationService.accept`
 * creates them in ONE transaction. No placeholder names, no fake profiles, no NOT NULL relaxation.
 *
 * Invariants enforced in PostgreSQL, not only in application code:
 *  - `member_invitation_one_live_per_email`: at most one live (not accepted/revoked/superseded) invitation
 *    per organisation + email — concurrent duplicate sends cannot both succeed (Twenty only checks this in
 *    application code).
 *  - `token_hash` UNIQUE; only the SHA-256 hash is stored — the raw token exists only in the email.
 *  - `member_invitation_single_terminal_state`: accepted / revoked / superseded are mutually exclusive.
 *  - `role_id` must be a CUSTOM workspace-member role of the SAME workspace: the composite FK
 *    (role_id, workspace_id) → role(id, workspace_id) can never match a system role (their workspace_id is
 *    NULL) or another workspace's role, so Staff, Venue Manager, Manager and leadership roles are
 *    unrepresentable here (WorkspaceMemberRoles1786714500000).
 *  - `send_count` is capped at 3 (same 24h / 3-send policy as account invitations).
 *  - `workspace_id` is the inviter's workspace UUID (never a mutable subdomain) and is mandatory: the
 *    recipient joins that existing workspace; no invitation ever creates a new one.
 *
 * `email_outbox` gains `member_invitation_id` and the `MEMBER_INVITATION` job type. That job type is the
 * ONLY one allowed to have no `target_user_id` at enqueue time — the worker's "missing target user ⇒
 * cancel" safeguard stays exactly as it is for every other job type and gains a strict invitation-specific
 * revalidation instead (`email-send.processor.ts`). A CHECK makes "MEMBER_INVITATION without an
 * invitation link" unrepresentable.
 */
export class MemberInvitationSchema1786715000000 implements MigrationInterface {
  name = 'MemberInvitationSchema1786715000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.member_invitation (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id      uuid NOT NULL,
        email             citext NOT NULL,
        role_id           uuid NOT NULL,
        token_hash        text NOT NULL,
        send_count        integer NOT NULL DEFAULT 1,
        expires_at        timestamptz NOT NULL,
        last_sent_at      timestamptz NOT NULL DEFAULT now(),
        invited_by        uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        accepted_at       timestamptz,
        accepted_user_id  uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        revoked_at        timestamptz,
        revoked_by        uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        superseded_at     timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT member_invitation_token_hash_key UNIQUE (token_hash),
        CONSTRAINT member_invitation_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
          REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT member_invitation_role_fkey FOREIGN KEY (role_id, workspace_id)
          REFERENCES core.role(id, workspace_id) ON DELETE RESTRICT,
        CONSTRAINT member_invitation_send_count_check CHECK (send_count BETWEEN 1 AND 3),
        CONSTRAINT member_invitation_email_normalised CHECK (email::text = lower(btrim(email::text)) AND length(email::text) BETWEEN 3 AND 254),
        CONSTRAINT member_invitation_single_terminal_state CHECK (
          (accepted_at IS NOT NULL)::int + (revoked_at IS NOT NULL)::int + (superseded_at IS NOT NULL)::int <= 1
        ),
        CONSTRAINT member_invitation_accepted_user CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX member_invitation_one_live_per_email ON core.member_invitation (organisation_id, email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;
    `);
    await queryRunner.query(`CREATE INDEX member_invitation_scope_idx ON core.member_invitation (organisation_id, workspace_id, created_at DESC);`);
    await queryRunner.query(`CREATE INDEX member_invitation_role_idx ON core.member_invitation (role_id);`);

    // Same ownership as every other pre-auth-readable identity table (account_invite, password_reset_token,
    // user, …): the NOLOGIN secure owner, never a runtime role.
    await queryRunner.query(`ALTER TABLE core.member_invitation OWNER TO rab_secure_owner;`);

    // SECURITY TRADE-OFF — ENABLE only, deliberately NOT FORCEd, identical in shape and reason to
    // `account_invite` (AccountInviteSchema1786670100000): the public acceptance endpoint must resolve which
    // organisation/workspace a bare token belongs to BEFORE any tenant context can exist, through the
    // SECURITY DEFINER function below, which runs as the table owner — FORCE would hide every row from it.
    // `crewflow_app` (not the owner, NOBYPASSRLS) is fully bound by the policy regardless; only the NOLOGIN
    // owner is exempt. Added to `tools/check-rls-coverage.ts`'s NOT_FORCED_ALLOWLIST in this same change.
    //
    // The policy is TIGHTER than organisation-only: an invitation is visible only inside its own workspace, so two
    // Managers in the same organisation never see, resend or revoke each other's invitations.
    await queryRunner.query(`ALTER TABLE core.member_invitation ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY member_invitation_scope ON core.member_invitation
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    // No DELETE for anyone: invitations end by state transition (accepted / revoked / superseded), never by
    // removal, so the history stays auditable.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.member_invitation TO crewflow, crewflow_app;`);

    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_member_invitation(p_token_hash text)
      RETURNS TABLE ("invitationId" uuid, "organisationId" uuid, "workspaceId" uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT id, organisation_id, workspace_id FROM core.member_invitation WHERE token_hash = p_token_hash;
      $$;
    `);
    // Returns only routing identifiers — never the email, role, state or any hash. Validity (live, unexpired,
    // organisation not suspended, workspace active) is decided afterwards under RLS, inside the acceptance
    // transaction, with a row lock.
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_member_invitation(text) FROM PUBLIC;`);
    await queryRunner.query(`ALTER FUNCTION core.auth_find_member_invitation(text) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_member_invitation(text) TO crewflow, crewflow_app;`);

    // Outbox linkage for invitation emails.
    await queryRunner.query(`ALTER TABLE core.email_outbox ADD COLUMN member_invitation_id uuid REFERENCES core.member_invitation(id) ON DELETE RESTRICT;`);
    await queryRunner.query(`CREATE INDEX email_outbox_member_invitation_idx ON core.email_outbox (member_invitation_id) WHERE member_invitation_id IS NOT NULL;`);
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_job_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (
        'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'PASSWORD_UPDATED', 'WELCOME', 'ACCOUNT_SUSPENDED', 'NOTIFICATION', 'MEMBER_INVITATION'
      ));
    `);
    await queryRunner.query(`
      ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_member_invitation_link CHECK (
        (job_type = 'MEMBER_INVITATION') = (member_invitation_id IS NOT NULL)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT IF EXISTS email_outbox_member_invitation_link;`);
    await queryRunner.query(`DELETE FROM core.email_outbox WHERE job_type = 'MEMBER_INVITATION';`);
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_job_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (
        'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'PASSWORD_UPDATED', 'WELCOME', 'ACCOUNT_SUSPENDED', 'NOTIFICATION'
      ));
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS core.email_outbox_member_invitation_idx;`);
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP COLUMN IF EXISTS member_invitation_id;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_member_invitation(text);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.member_invitation;`);
  }
}
