import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Owner decision 2026-10-17: a shift's offer actions close five hours after its scheduled end. Enforced here, at the
 * service layer every offer path calls (send, staff accept, manager confirm), against DATABASE time — never the
 * client's clock and never only by hiding a button. It does not touch confirmed assignments, attendance, the QR
 * clock-in/out window or offer expiry (`job_offer.expires_at` still applies independently, whichever is earlier).
 */
export const SHIFT_ACTION_WINDOW_HOURS = 5;

const MESSAGES = {
  send: 'This shift ended more than 5 hours ago, so no new offers can be sent for it.',
  accept: 'This shift ended more than 5 hours ago, so this offer can no longer be accepted.',
  confirm: 'This shift ended more than 5 hours ago, so this offer can no longer be confirmed.',
} as const;

/** 409 when the shift's action window has closed. Call with the shift row already locked by the caller where it writes. */
export async function assertShiftActionWindowOpen(manager: EntityManager, shiftId: string, action: keyof typeof MESSAGES): Promise<void> {
  const [row] = await manager.query(
    `SELECT now() >= ends_at + make_interval(hours => $2) AS closed FROM shift WHERE id = $1`,
    [shiftId, SHIFT_ACTION_WINDOW_HOURS],
  );
  if (row?.closed) throw new ConflictException(MESSAGES[action]);
}
