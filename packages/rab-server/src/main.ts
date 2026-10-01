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
import { buildTrustProxyPredicate } from './engine/utils/trusted-proxy.util';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await assertRuntimeDbRole(app.get(DataSource), 'API server');
  // SIGTERM/SIGINT -> stop accepting connections, let in-flight requests finish, then close Postgres/Redis/BullMQ
  // (each provider's onModuleDestroy). Without this Node exits immediately and drops in-flight requests and connections.
  app.enableShutdownHooks();
  releaseEarlyBootSignalGuard(); // Nest's own SIGTERM/SIGINT handling is now installed

  const environmentService = app.get(EnvironmentService);

  // SEC-03 / PHASE 11 EDGE-01: without `trust proxy`, Express ignores
  // `X-Forwarded-For` entirely (default `trust proxy = false`), so every
  // request — from every distinct real client — reaches `req.ip`/`req.ips`
  // as whichever proxy fronts this service instead of the real caller: the
  // rate limiter (`RabThrottlerModule`) would then bucket every caller
  // together under one shared address, letting one abusive client exhaust
  // the limit for everyone else.
  //
  // The function form (not a bare hop-count number, and never `true`) only
  // trusts an X-Forwarded-For entry as a proxy hop when that entry's own
  // address is itself listed in `TRUSTED_PROXY_CIDRS` — see
  // `trusted-proxy.util.ts`'s doc comment for why header PRESENCE was never
  // sufficient proof on its own. Empty by default: an unconfigured
  // deployment trusts no hop at all, and `req.ip` resolves to the raw
  // socket peer for every caller — always safe, never a spoofing vector,
  // even though it means every real caller behind an actual,
  // still-unconfigured proxy shares one address until that proxy's address
  // range is added to the config. `resolveClientIp`
  // (`engine/utils/client-ip.util.ts`, used by the throttler and by
  // `login_history`'s IP column) additionally prefers Cloudflare's own
  // `CF-Connecting-IP` header over this resolution, but ONLY for a peer
  // this SAME predicate already trusts — never unconditionally.
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', buildTrustProxyPredicate(environmentService.trustedProxyCidrs));

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

  // Explicit origin allowlist from env, never "*" — rab-workforce-architecture.md §5.5.
  app.enableCors({ origin: environmentService.corsOrigins, credentials: true, exposedHeaders: ['Retry-After'] });

  const port = environmentService.get('PORT');

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`rab-server listening on :${port}`);
}

bootstrap();
