import { EntityManager } from 'typeorm';

/**
 * Phase C1b (D5) — push registrations end with the session that made them. Plain functions over the CALLER's
 * `EntityManager`, so each runs inside the same transaction as the logout / revocation / suspension it belongs to
 * (a rolled-back revocation never deactivates a device; a committed one always has). `core.push_device` RLS is
 * organisation-scoped, so these only ever reach the organisation the transaction is bound to.
 *
 * There is NO session → device link yet (`push_device` has no `session_id`), so the rules are deliberately
 * conservative: "this device" only when the client names it (logout), "every device" only when every session of the
 * account ends or the account/organisation/workspace access is suspended, and otherwise "every device, but only once
 * the account has no live session left" — never a guess at which other device belonged to a revoked session. The
 * prepared schema change that makes per-session deactivation exact is `docs/plans/C1-PUSH-SESSION-LINK-MIGRATION.md`.
 */

/** One installation of one user (`device_id` = the id the client registered with). Idempotent; an unknown id is a no-op. */
export async function deactivatePushDeviceForUser(manager: EntityManager, userId: string, deviceId: string, reason: string): Promise<number> {
  const [, count] = (await manager.query(
    `UPDATE core.push_device SET active = false, deactivated_at = now(), deactivated_reason = $3
      WHERE user_id = $1 AND device_id = $2 AND active = true`,
    [userId, deviceId, reason],
  )) as [unknown, number];
  return count ?? 0;
}

/** Every active registration of one user — every session of the account ended, or the account lost access. */
export async function deactivateAllPushDevicesForUser(manager: EntityManager, userId: string, reason: string): Promise<number> {
  const [, count] = (await manager.query(
    `UPDATE core.push_device SET active = false, deactivated_at = now(), deactivated_reason = $2
      WHERE user_id = $1 AND active = true`,
    [userId, reason],
  )) as [unknown, number];
  return count ?? 0;
}

/** Every active registration in one organisation — organisation suspension. */
export async function deactivateAllPushDevicesForOrganisation(manager: EntityManager, organisationId: string, reason: string): Promise<number> {
  const [, count] = (await manager.query(
    `UPDATE core.push_device SET active = false, deactivated_at = now(), deactivated_reason = $2
      WHERE organisation_id = $1 AND active = true`,
    [organisationId, reason],
  )) as [unknown, number];
  return count ?? 0;
}

/**
 * After ONE session (or every session but one) was revoked: with no session → device link the revoked session's own
 * device cannot be singled out, so nothing is touched while the account still has a live session; once none is left
 * (the revoked one was the last), every registration goes — a device with no session must not keep receiving pushes.
 *
 * "Live" is the SAME predicate `SessionValidityService` authenticates with (review F1, interim until the session-link
 * migration): not revoked, before its absolute deadline, and not idle-expired. An idle or expired session can no longer
 * authenticate anything, so it must not keep another device's registration alive.
 */
export async function deactivatePushDevicesIfNoLiveSession(manager: EntityManager, userId: string, reason: string): Promise<number> {
  const [, count] = (await manager.query(
    `UPDATE core.push_device SET active = false, deactivated_at = now(), deactivated_reason = $2
      WHERE user_id = $1 AND active = true
        AND NOT EXISTS (SELECT 1 FROM core.user_session s
                         WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.absolute_expires_at > now()
                           AND (s.idle_expires_at IS NULL OR s.idle_expires_at > now()))`,
    [userId, reason],
  )) as [unknown, number];
  return count ?? 0;
}
