import type { EntityManager } from 'typeorm';


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

/** A pre-authentication failed login (no audit row, no organisation). The raw address is masked before it leaves. */
export interface PreAuthLoginFailure {
  email: unknown;
  reason: 'invalid_credentials' | 'ambiguous_accounts' | 'provider_sign_in_refused';
  provider: string;
  /** A provider refusal code (`state_invalid`, `ambiguous_accounts`, ...), never an error message. */
  providerReason?: string;
}

export interface AuditEventShipper {
  afterCommit(manager: EntityManager, row: AuditRowToShip): boolean;
  /** Queued fire-and-forget (owner guard: dropped and counted above the audit-queue backlog limit). Never awaited. */
  shipPreAuthLoginFailure(failure: PreAuthLoginFailure): void;
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

/**
 * Hands a pre-authentication failed login to the audit queue: synchronous, fire-and-forget. The caller (the login path)
 * never awaits anything here, and nothing here can change its response, timing class or status.
 */
export function shipPreAuthLoginFailure(failure: PreAuthLoginFailure): void {
  try {
    current?.shipPreAuthLoginFailure(failure);
  } catch {
    // best effort: never into the caller
  }
}
