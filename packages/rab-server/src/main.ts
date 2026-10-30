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
import { buildCorsOptionsDelegate, WorkspaceOriginTrustService } from './engine/core-modules/workspace-host/workspace-origin-trust.service';
import { WorkspaceHostResolverService } from './engine/core-modules/workspace-host/workspace-host-resolver.service';
import { assertHwsStartupInvariants, HwsStartupError } from './database/typeorm/core/hws-startup-guard';
import { assertRuntimeDatabaseIdentity, RuntimeDbError } from './database/typeorm/core/runtime-database-guard';
import { runDatabaseBootGates } from './database/boot-checks/database-boot-gates';

/** Refuses to start: prints a sanitised reason and exits non-zero before any listener or connection is opened. */
function refuseStartup(error: unknown): never {
  const message = error instanceof Error ? error.message : 'unknown error';
  // eslint-disable-next-line no-console
  console.error(
    error instanceof RuntimeDbError
      ? `[runtime-db-guard] refused: ${message}`
      : error instanceof HwsStartupError
        ? `[hws-startup-guard] refused: ${message}`
        : message,
  );
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  // RUNTIME boundary: the database identity is verified BEFORE NestFactory opens any connection or any listener.
  await assertRuntimeDatabaseIdentity('api').catch(refuseStartup);
  // Phase B boot gates (role, version, extensions, deployment identity, FORCE RLS, TLS, pending migrations), before Nest.
  await runDatabaseBootGates('api').catch(refuseStartup);
  const app = await NestFactory.create(AppModule);
  await assertRuntimeDbRole(app.get(DataSource), 'API server');
  const environmentService = app.get(EnvironmentService);
  // HWS runtime cutover (Part 26): no-op unless HWS_RUNTIME_ENABLED=true, in which case a hole in the registry, the
  // entity/schema classification, or the migrations-table qualification is refused here, before any request or job.
  await assertHwsStartupInvariants(app.get(DataSource), environmentService.get('HWS_RUNTIME_ENABLED')).catch(refuseStartup);
  // SIGTERM/SIGINT -> stop accepting connections, let in-flight requests finish, then close Postgres/Redis/BullMQ
  // (each provider's onModuleDestroy). Without this Node exits immediately and drops in-flight requests and connections.
  app.enableShutdownHooks();
  releaseEarlyBootSignalGuard(); // Nest's own SIGTERM/SIGINT handling is now installed

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
  // Function form (not the plain corsOrigins array) so a workspace subdomain origin can
  // also be trusted — see EnvironmentService.isTrustedOrigin's own doc comment for the
  // exact rule. Never reflects an arbitrary Origin: a request from an untrusted origin is
  // rejected (`callback(null, false)`), not allowed through with no CORS headers.
  //
  // Wave 3 lane H: the callback first resolves a workspace-shaped Origin against the host-label registry (READY workspace,
  // exact canonical origin — see WorkspaceOriginTrustService), then applies the same synchronous predicate every other
  // consumer uses. Any failure means "not allowed".
  // W6-E2E-03: per request. On a workspace host only that host's own origin (and CORS_ORIGINS) may read credentialed
  // responses; other workspaces' origins are trusted for their own hosts only (buildCorsOptionsDelegate).
  app.enableCors(
    buildCorsOptionsDelegate(app.get(WorkspaceOriginTrustService), app.get(WorkspaceHostResolverService), {
      credentials: true,
      exposedHeaders: ['Retry-After'],
    }),
  );

  const port = environmentService.get('PORT');

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`rab-server listening on :${port}`);
}

bootstrap();
