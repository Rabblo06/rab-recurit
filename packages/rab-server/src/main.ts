import 'dotenv/config';
import './instrument';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { EnvironmentService } from './engine/core-modules/environment/environment.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const environmentService = app.get(EnvironmentService);

  // Explicit origin allowlist from env, never "*" — rab-workforce-architecture.md §5.5.
  app.enableCors({ origin: environmentService.corsOrigins, credentials: true });

  const port = environmentService.get('PORT');

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`rab-server listening on :${port}`);
}

bootstrap();
