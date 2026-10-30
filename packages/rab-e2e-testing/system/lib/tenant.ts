import { HWS_ON } from './env';
import type { Tenant } from './state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Where a tenant's business rows live, for the superuser evidence queries: its own workspace schema with HWS runtime
 * routing on (devlike), the shared `core` table without it (parity, as production runs). Always pair it with `scope(t)`.
 */
export function tbl(t: Tenant, table: string): string {
  if (!IDENT.test(table)) throw new Error(`e2e: bad table name ${table}`);
  if (!HWS_ON) return `core.${table}`;
  if (!t.schema || !IDENT.test(t.schema)) throw new Error('e2e: tenant has no workspace schema in its state');
  return `${t.schema}.${table}`;
}

/** The SQL predicate that keeps a `tbl(t, …)` query to tenant `t`: nothing extra in its own schema, its organisation in `core`. */
export function scope(t: Tenant): string {
  if (HWS_ON) return 'true';
  if (!t.orgId || !UUID.test(t.orgId)) throw new Error('e2e: tenant has no organisation id in its state');
  return `organisation_id = '${t.orgId}'`;
}
