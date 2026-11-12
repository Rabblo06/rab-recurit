import type { EntityManager } from 'typeorm';

import type { SecurityAuditEvent } from '../audit-sink/security-audit-sink';

/**
 * Phase X Part 2, X1.1: the ONE entry point every `core.audit_log` writer calls after its insert, and the pre-auth
 * login-failure hand-off. Process-wide (like security-readiness.ts's provider list): the enabled AuditEventQueueService of
 * this process registers itself; with no sink configured (CREWFLOW_AUDIT_SINK unset / none — development and tests) nothing
 * is registered and both calls do nothing.
 *
 * Why a process-wide hand-off rather than a constructor dependency: besides `AuditService.record`, the writers are the
 * Worker's plain job functions (email dispatch, account-invite cleanup — about sixty call sites in jobs and specs) and the
 * platform-admin e-mail replay; and the pre-auth login failures come from the auth services. One function keeps every
 * writer on the same path without threading a new parameter through all of them.
 *
 * NEVER throws and never awaits Redis or the sink: a shipping problem cannot block, slow or roll back the caller.
 */
export interface AuditRowToShip {
  organisationId: string;
  auditLogId: string;
  /** The row's action: filtered against the security catalogue BEFORE anything is registered. */
  action: string;
}

export interface AuditEventShipper {
  afterCommit(manager: EntityManager, row: AuditRowToShip): boolean;
  shipPreAuth(event: SecurityAuditEvent): void;
}

let current: AuditEventShipper | null = null;

export function registerAuditEventShipper(shipper: AuditEventShipper): void {
  current = shipper;
}

export function unregisterAuditEventShipper(shipper: AuditEventShipper): void {
  if (current === shipper) current = null;
}

/** Test seam only. */
export function currentAuditEventShipperForTests(): AuditEventShipper | null {
  return current;
}

/**
 * Registers the off-host copy of a just-inserted audit row, to be queued after `manager`'s outermost commit (or at once
 * when `manager` has no open transaction, i.e. the insert already committed). True when registered.
 */
export function shipAuditRowAfterCommit(manager: EntityManager, row: AuditRowToShip): boolean {
  try {
    return current?.afterCommit(manager, row) ?? false;
  } catch {
    return false;
  }
}

/** Writes a pre-authentication security event (no organisation, no audit row) to the sink, detached. */
export function shipPreAuthSecurityEvent(event: SecurityAuditEvent): void {
  try {
    current?.shipPreAuth(event);
  } catch {
    // best effort: never into the caller
  }
}
