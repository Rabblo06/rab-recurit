/**
 * The same connection string with `application_name=<name>`, so every backend of ONE spawned process can be found in
 * pg_stat_activity by that name.
 *
 * Phase B: a spawned Worker process no longer honours `PGAPPNAME`. Every connection comes from the connection factory
 * (@rab/server database/postgres/create-pg-pool.ts), which always sets `application_name` explicitly: the URL's own
 * `application_name` when it has one, else `crewflow-<process>[-<purpose>]` — the same for every replica, so it cannot tell
 * two spawned provisioners apart. The URL's own value is the factory's application_name for every connection that process
 * opens (provisioning, drift, identity probes), exactly the per-process scope `PGAPPNAME` used to give.
 */
export function withApplicationName(url: string, name: string): string {
  if (!/^[a-z0-9-]{1,63}$/.test(name)) {
    throw new Error('application_name for a spawned test process must be 1-63 lowercase letters, digits or dashes');
  }
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', name);
  return parsed.toString();
}
