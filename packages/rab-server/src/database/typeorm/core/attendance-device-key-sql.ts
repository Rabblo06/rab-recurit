// sql-injection-reviewed-file: SQL definition module (database layer). Constant DDL only; no interpolation of request or row data.

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design Appendix A.5; §13 PR 2). `core.attendance_device_key`: the public half of
 * a phone's offline-signing key (ES256, SPKI DER), core only (tied to the user and the session family, like core.push_device).
 * Not read by any pre-auth lookup, so ENABLE + FORCE with one own-row policy (organisation AND user); with no tenant context
 * bound it returns zero rows. No DELETE grant and a DELETE guard: revoked rows are purged 90 days after revoked_at by the Worker
 * through a crewflow definer (D15, §13 PR 10), never by the runtime. Revocation of another user's key goes through the session
 * family, not this table (§6.3).
 */
export const ATTENDANCE_DEVICE_KEY_SQL: readonly string[] = Object.freeze([
  `CREATE TABLE core.attendance_device_key (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid        NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
  session_family_id uuid        NOT NULL,
  install_id        text        NOT NULL,
  platform          text        NOT NULL,
  algorithm         text        NOT NULL DEFAULT 'ES256',
  public_key_spki   bytea       NOT NULL,
  key_thumbprint    text        NOT NULL,
  hardware_backed   boolean     NOT NULL DEFAULT false,
  attestation       text        NOT NULL DEFAULT 'none',
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text,
  CONSTRAINT attendance_device_key_platform_check    CHECK (platform IN ('ios', 'android')),
  CONSTRAINT attendance_device_key_algorithm_check   CHECK (algorithm = 'ES256'),
  CONSTRAINT attendance_device_key_attestation_check CHECK (attestation IN ('none', 'app_attest', 'play_integrity')),
  CONSTRAINT attendance_device_key_spki_check        CHECK (octet_length(public_key_spki) BETWEEN 59 AND 160),
  CONSTRAINT attendance_device_key_thumb_check       CHECK (key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT attendance_device_key_install_check     CHECK (char_length(install_id) BETWEEN 8 AND 128),
  CONSTRAINT attendance_device_key_revoked_pair      CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT attendance_device_key_revoked_reason    CHECK (revoked_reason IS NULL OR revoked_reason IN
                                                            ('logout', 'session_revoked', 'rotated', 'admin', 'user_deleted'))
)`,
  `CREATE UNIQUE INDEX attendance_device_key_active_install ON core.attendance_device_key USING btree (user_id, install_id) WHERE revoked_at IS NULL`,
  `CREATE UNIQUE INDEX attendance_device_key_org_thumbprint ON core.attendance_device_key USING btree (organisation_id, key_thumbprint)`,
  `CREATE INDEX attendance_device_key_revoked_idx ON core.attendance_device_key USING btree (revoked_at) WHERE revoked_at IS NOT NULL`,
  `ALTER TABLE core.attendance_device_key ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE core.attendance_device_key FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY attendance_device_key_own ON core.attendance_device_key AS PERMISSIVE FOR ALL TO PUBLIC
  USING (organisation_id = core.current_org() AND user_id = core.current_uid())
  WITH CHECK (organisation_id = core.current_org() AND user_id = core.current_uid())`,
  `REVOKE ALL ON core.attendance_device_key FROM PUBLIC`,
  `REVOKE ALL ON core.attendance_device_key FROM crewflow_app`,
  `GRANT SELECT, INSERT ON core.attendance_device_key TO crewflow_app`,
  `GRANT UPDATE (last_used_at, revoked_at, revoked_reason) ON core.attendance_device_key TO crewflow_app`,
  // A.7 for the runtime login (it inherits the owner, so the column grant above does not bind it): the key, its thumbprint, its
  // owner and its session family can never change after registration; a revoked key never changes again (no un-revoke;
  // core.attendance_device_key_revoked_guard, review of #353 item 4); DELETE and TRUNCATE are refused for the runtime (the D15
  // purge, §13 PR 10, deletes through a crewflow definer, which the guard lets through).
  `CREATE TRIGGER attendance_device_key_guard_update BEFORE UPDATE ON core.attendance_device_key FOR EACH ROW
  EXECUTE FUNCTION core.owner_login_grant_parity_guard('last_used_at', 'revoked_at', 'revoked_reason')`,
  `CREATE TRIGGER attendance_device_key_revoked_guard BEFORE UPDATE ON core.attendance_device_key FOR EACH ROW
  EXECUTE FUNCTION core.attendance_device_key_revoked_guard()`,
  `CREATE TRIGGER attendance_device_key_guard_delete BEFORE DELETE ON core.attendance_device_key FOR EACH STATEMENT
  EXECUTE FUNCTION core.owner_login_grant_parity_guard()`,
  `CREATE TRIGGER attendance_device_key_guard_truncate BEFORE TRUNCATE ON core.attendance_device_key FOR EACH STATEMENT
  EXECUTE FUNCTION core.owner_login_grant_parity_guard()`,
]);

export const ATTENDANCE_DEVICE_KEY_TRIGGERS = [
  { name: 'attendance_device_key_guard_update', tgtype: 19, fn: 'core.owner_login_grant_parity_guard()' },
  { name: 'attendance_device_key_revoked_guard', tgtype: 19, fn: 'core.attendance_device_key_revoked_guard()' },
  { name: 'attendance_device_key_guard_delete', tgtype: 10, fn: 'core.owner_login_grant_parity_guard()' },
  { name: 'attendance_device_key_guard_truncate', tgtype: 34, fn: 'core.owner_login_grant_parity_guard()' },
] as const;
