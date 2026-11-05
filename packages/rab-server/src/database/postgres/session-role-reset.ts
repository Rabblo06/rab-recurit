import type { Pool, PoolClient } from 'pg';
import type { DataSource } from 'typeorm';

/**
 * Pool safety for the owner login (M0 §6.4 control 3; G-09 "pool poisoning", owner-accepted residual otherwise).
 *
 * THE THREAT. `SET ROLE x` or `SELECT set_config('role', 'x', false)` is SESSION-level: it survives COMMIT. The owner
 * login crewflow_owner may SET ROLE to rab_secure_owner and crewflow, so one injected statement in request A would make
 * every later request served on the same pooled connection run as rab_secure_owner — which bypasses the M-T1 policies
 * (CURRENT_USER = 'rab_secure_owner') and reads every tenant's pre-auth rows. The restricted crewflow_app login could not
 * SET ROLE to anything, so this did not exist before the owner login.
 *
 * TWO LAYERS (both cheap, neither replaces the other):
 *  1. on CHECKOUT — `installSessionRoleResetOnAcquire(pool)`: pg-pool emits 'acquire' synchronously BEFORE it hands the
 *     client to the caller, and a pg Client runs queries strictly in submission order, so the `RESET ROLE` queued here
 *     executes before the caller's first statement — every user of the pool (tenant-context or not: pre-auth lookups,
 *     health checks, jobs) starts as the login itself. No extra round trip is waited for.
 *  2. inside every tenant-context transaction — TenantContextService runs `RESET ROLE` and asserts
 *     `current_user = session_user` before binding the tenant (fails closed: throws, nothing runs).
 *
 * WHY NOT `DISCARD ALL`: it cannot run inside a transaction block (it errors), and on checkout it would also
 * `UNLISTEN *` (the Worker's wake listener), release session advisory locks (the scan / migration locks) and drop
 * prepared statements — far more than this threat needs. `RESET ROLE` is allowed inside and outside a transaction and in
 * READ ONLY transactions; it touches nothing else. node-postgres uses unnamed prepared statements by default, which are
 * unaffected either way.
 *
 * NOT COVERED (residual, recorded in THREAT-MODEL.md): other session-level settings an injected statement can leave
 * behind (e.g. `set_config('rab.organisation_id', …, false)` — the tenant GUCs are re-bound transaction-locally on every
 * tenant-context call, which overrides them there), and anything injected SQL does inside its own request. A failed
 * checkout reset is logged and the client is not trusted further for tenant work only through layer 2.
 */
export const RESET_ROLE_SQL = 'RESET ROLE';

const installed = new WeakSet<object>();

export function installSessionRoleResetOnAcquire(pool: Pool, log: (line: string) => void = (l) => console.warn(l)): void { // eslint-disable-line no-console
  if (installed.has(pool)) return;
  installed.add(pool);
  pool.on('acquire', (client: PoolClient) => {
    // Queued before the caller's first query (see layer 1). Never awaited here: 'acquire' handlers are synchronous.
    client.query(RESET_ROLE_SQL).catch((error: { code?: string }) => {
      log(`[pool-safety] RESET ROLE on checkout failed (driver code ${error?.code ?? 'unknown'}); tenant-context transactions re-check the role`);
    });
  });
}

/** The pg Pool(s) behind an initialized TypeORM postgres DataSource (master + any replicas). */
export function installSessionRoleResetOnDataSource(dataSource: DataSource): void {
  const driver = dataSource.driver as unknown as { master?: Pool; slaves?: Pool[] };
  if (driver.master) installSessionRoleResetOnAcquire(driver.master);
  for (const slave of driver.slaves ?? []) installSessionRoleResetOnAcquire(slave);
}
