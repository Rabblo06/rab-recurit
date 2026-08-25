import 'dotenv/config';
import './instrument';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { EnvironmentService } from './engine/core-modules/environment/environment.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

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
