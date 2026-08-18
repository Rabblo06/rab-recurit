/**
 * CI gate (rab-workforce-architecture.md §5.7, §5.6): every table in schema
 * `core` with an `organisation_id` column must have Row-Level Security
 * enabled AND forced, and the application role (rab_app) must not have
 * BYPASSRLS. Run with a connection that can read `pg_class`/`pg_roles` —
 * DATABASE_URL is sufficient (no elevated grants needed for these reads).
 *
 * If the app ever connected as the table owner, RLS would be silently
 * skipped for every query it runs — this check is what makes that regressed
 * state fail CI instead of shipping quietly.
 */
import { Client } from 'pg';

const APP_ROLE = process.env.RAB_APP_ROLE ?? 'rab_app';

/**
 * Tables deliberately not FORCEd — each needs a SECURITY TRADE-OFF note at
 * its migration explaining why (see IdentitySchema1786665800000 for
 * `organisation`/`user`: pre-auth login lookups can't satisfy a forced
 * tenant policy because no tenant context exists yet). Still must have
 * `rowsecurity = true` — this only relaxes the FORCE requirement, never the
 * "RLS enabled at all" one.
 */
const NOT_FORCED_ALLOWLIST = new Set(['user', 'login_history', 'refresh_token', 'password_reset_token']);

interface UnprotectedTable {
  table: string;
  rowsecurity: boolean;
  forced: boolean;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run check-rls-coverage');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const tenantTables = await client.query<{ table_name: string }>(
      `SELECT DISTINCT table_name
         FROM information_schema.columns
        WHERE table_schema = 'core' AND column_name = 'organisation_id'`,
    );

    const unprotected: UnprotectedTable[] = [];
    for (const row of tenantTables.rows) {
      const { rows } = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE oid = $1::regclass`,
        [`core."${row.table_name}"`],
      );
      const status = rows[0];
      const requiresForce = !NOT_FORCED_ALLOWLIST.has(row.table_name);
      const isProtected = Boolean(status?.relrowsecurity) && (!requiresForce || Boolean(status?.relforcerowsecurity));
      if (!isProtected) {
        unprotected.push({
          table: row.table_name,
          rowsecurity: Boolean(status?.relrowsecurity),
          forced: Boolean(status?.relforcerowsecurity),
        });
      }
    }

    const roleResult = await client.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    );
    const appRoleBypassesRls = roleResult.rows[0]?.rolbypassrls ?? null;

    let failed = false;

    if (unprotected.length > 0) {
      failed = true;
      console.error(`RLS coverage FAILED — tenant tables missing full RLS protection:\n`);
      for (const t of unprotected) {
        console.error(
          `  core.${t.table}: rowsecurity=${t.rowsecurity} forceRowSecurity=${t.forced}` +
            ` — needs ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY + a policy`,
        );
      }
      console.error('');
    }

    if (appRoleBypassesRls === null) {
      console.warn(
        `Role "${APP_ROLE}" does not exist yet in this database — skipping the BYPASSRLS check ` +
          `(expected before the M1 role-bootstrap is wired into this environment).`,
      );
    } else if (appRoleBypassesRls) {
      failed = true;
      console.error(
        `RLS coverage FAILED — role "${APP_ROLE}" has BYPASSRLS. The app must connect as a role ` +
          `with NOBYPASSRLS or every policy above is decoration.\n`,
      );
    }

    if (failed) {
      process.exit(1);
    }

    console.log(
      `RLS coverage OK — ${tenantTables.rows.length} tenant table(s) checked, all protected.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('check-rls-coverage crashed:', error);
  process.exit(1);
});
