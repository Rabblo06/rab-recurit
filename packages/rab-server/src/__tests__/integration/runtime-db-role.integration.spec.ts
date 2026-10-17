import { DataSource } from 'typeorm';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { assertRuntimeDbRole } from '../../engine/utils/assert-runtime-db-role';

/**
 * CF-43 (October 15 audit): the runtime role check used to read `current_user` only, so a superuser login that ran
 * `SET ROLE crewflow_app` (or any role switched into it) passed. Now the LOGIN identity must be crewflow_app itself.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-43 runtime database role assertion (integration)', () => {
  const { appUrl, adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);

  async function withSource(url: string, fn: (ds: DataSource) => Promise<void>, roleSwitch?: string): Promise<void> {
    const ds = new DataSource({ type: 'postgres', url, entities: [], synchronize: false, extra: { max: 1 } });
    await ds.initialize();
    try {
      if (roleSwitch) await ds.query(`SET ROLE ${roleSwitch}`);
      await fn(ds);
    } finally {
      await ds.destroy();
    }
  }

  it('accepts a genuine crewflow_app login', async () => {
    await withSource(appUrl, (ds) => expect(assertRuntimeDbRole(ds, 'api')).resolves.toBeUndefined());
  });

  it('refuses a superuser login that switched to crewflow_app with SET ROLE', async () => {
    await withSource(adminUrl, (ds) => expect(assertRuntimeDbRole(ds, 'api')).rejects.toThrow(/SET ROLE is not accepted|not "crewflow_app" itself/), 'crewflow_app');
  });

  it('refuses the superuser login outright', async () => {
    await withSource(adminUrl, (ds) => expect(assertRuntimeDbRole(ds, 'api')).rejects.toThrow(/Refusing to start/));
  });
});
