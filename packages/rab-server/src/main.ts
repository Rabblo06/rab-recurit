import 'dotenv/config';
import './instrument';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { DataSource } from 'typeorm';

import { AppModule } from './app.module';
import { EnvironmentService } from './engine/core-modules/environment/environment.service';

const RUNTIME_DB_ROLE = process.env.RAB_APP_ROLE ?? 'rab_app';

/**
 * A cryptographically valid request can still be served against the wrong
 * database role — RLS's non-FORCE'd tables (organisation, user,
 * login_history, refresh_token, password_reset_token; see
 * tools/check-rls-coverage.ts) are fully unscoped for a table-owner
 * connection regardless of tenant context. This mirrors that CI check at
 * boot, catching a misconfigured DATABASE_URL (e.g. accidentally pointed at
 * the migration/owner role) before the process ever serves a request,
 * rather than discovering it via a cross-tenant data leak.
 */
async function assertRuntimeDbRole(dataSource: DataSource): Promise<void> {
  const [{ current_user: connectedAs }] = await dataSource.query<[{ current_user: string }]>(
    'SELECT current_user',
  );
  if (connectedAs !== RUNTIME_DB_ROLE) {
    throw new Error(
      `Refusing to start: DATABASE_URL connects as "${connectedAs}", not "${RUNTIME_DB_ROLE}". ` +
        'The API server must never run as the migration/owner role — see postgres-init/01-roles.sql.',
    );
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await assertRuntimeDbRole(app.get(DataSource));

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // cookie-parser is registered in AppModule.configure(), not here — see
  // that comment for why (test bootstraps never run this function at all).

  // Helmet's default Cross-Origin-Resource-Policy is 'same-origin' — correct
  // for a server that also serves its own HTML, wrong here: this is a pure
  // JSON API that `rab-front`/`rab-mobile` call cross-origin by design (CORS
  // above is the actual access control). 'cross-origin' is Helmet's own
  // documented setting for exactly this API-server shape.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const environmentService = app.get(EnvironmentService);

  // Explicit origin allowlist from env, never "*" — rab-workforce-architecture.md §5.5.
  app.enableCors({ origin: environmentService.corsOrigins, credentials: true });

  const port = environmentService.get('PORT');

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`rab-server listening on :${port}`);
}

bootstrap();
