import { Client } from 'pg';

import { PG_PORT, stackSecrets } from './env';

/**
 * Superuser connection to the DISPOSABLE e2e database only (127.0.0.1:15470, database rab_e2e). Used for evidence queries
 * ("which schema did the row land in"), never for writes the product would make. Refuses any other port/database.
 */
export async function withSuperuser<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const secrets = stackSecrets();
  const c = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'rab', password: secrets.E2E_PG_SUPERUSER_PASSWORD, database: 'rab_e2e' });
  await c.connect();
  try {
    const db = (await c.query('select current_database() as d, inet_server_port() as p')).rows[0];
    if (db.d !== 'rab_e2e') throw new Error(`e2e: connected to unexpected database ${db.d}`);
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (c) => (await c.query(text, params)).rows as T[]);
}
