import { releaseEarlyBootSignalGuard } from './engine/utils/early-boot-signal-guard'; // MUST stay the first import
import 'dotenv/config';
import './instrument';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { DataSource } from 'typeorm';

import { AppModule } from './app.module';
import { EnvironmentService } from './engine/core-modules/environment/environment.service';
import { assertRuntimeDbRole } from './engine/utils/assert-runtime-db-role';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await assertRuntimeDbRole(app.get(DataSource), 'API server');
  // SIGTERM/SIGINT -> stop accepting connections, let in-flight requests finish, then close Postgres/Redis/BullMQ
  // (each provider's onModuleDestroy). Without this Node exits immediately and drops in-flight requests and connections.
  app.enableShutdownHooks();
  releaseEarlyBootSignalGuard(); // Nest's own SIGTERM/SIGINT handling is now installed

  // SEC-03: without `trust proxy`, Express ignores `X-Forwarded-For`
  // entirely (default `trust proxy = false`), so every request — from every
  // distinct real client — reaches `req.ip`/`req.ips` as whichever proxy
  // fronts this service instead of the real caller: the rate limiter
  // (`RabThrottlerModule`) would then bucket every caller together under one
  // shared address, letting one abusive client exhaust the limit for
  // everyone else. Production (`rab-server-stfz.onrender.com`) is verified
  // Cloudflare-fronted (live response headers: `Server: cloudflare`,
  // `CF-RAY`) sitting in front of Render's own edge — `resolveClientIp`
  // (`engine/utils/client-ip.util.ts`, used by the throttler and by
  // `login_history`'s IP column) prefers Cloudflare's own un-spoofable
  // `CF-Connecting-IP` header for that reason, sidestepping the exact
  // Render-internal hop count entirely.
  //
  // `trust proxy = 1` here is only the fallback path `resolveClientIp` takes
  // when `CF-Connecting-IP` is absent (local dev, or any future deployment
  // target that isn't Cloudflare-fronted) — an exact hop COUNT, not `true`,
  // so Express trusts only the nearest hop and takes the client IP from the
  // entry immediately before it; any extra addresses a client prepends
  // further back in `X-Forwarded-For` stay untrusted. This does NOT change
  // CORS/Origin verification (a separate, unrelated header) and does not
  // change how any authorization decision is made — it only affects what
  // `req.ip` resolves to.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

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
  app.enableCors({ origin: environmentService.corsOrigins, credentials: true, exposedHeaders: ['Retry-After'] });

  const port = environmentService.get('PORT');

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`rab-server listening on :${port}`);
}

bootstrap();
