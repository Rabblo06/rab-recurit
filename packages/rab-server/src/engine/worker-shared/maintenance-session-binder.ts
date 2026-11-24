/**
 * The Worker's entry point to the trusted GUC binder for maintenance sessions (import-boundaries: the Worker reaches
 * rab-server only through engine/worker-shared/). A re-export only: the binding statement and its parameter mapping stay in
 * engine/core-modules/tenant/tenant-context.service.ts, the one place that writes rab.actor_type
 * (worker-actor-type-trusted-only.spec.ts). Used by the account-invite cleanup's level-22 pass.
 */
export { bindMaintenanceSessionGucs } from '../core-modules/tenant/tenant-context.service';
export type { BindIdentity, BindQuery } from '../core-modules/tenant/tenant-context.service';
