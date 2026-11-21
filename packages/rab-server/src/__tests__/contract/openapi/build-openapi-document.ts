import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { CanActivate, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { applyGlobalValidationPipe } from '../../../engine/utils/global-validation-pipe';
import { CONTRACT_COMPONENTS, CONTRACT_RESPONSES } from './contract-responses';
import { attachOpenApiMetadata, requestDtosOf } from './dto-openapi-metadata';

/**
 * Build-time only: the OpenAPI document of the HTTP API, generated from the code. Never imported by the application
 * (`src/__tests__/**` is outside the app build; openapi-build-time-only.spec.ts pins that nothing else imports
 * @nestjs/swagger and that main.ts serves no document).
 *
 * Sources, all read from the code:
 *  - routes, path/query parameters and request bodies: the controllers' Nest metadata, read by @nestjs/swagger's own
 *    scanner over a Nest application holding every controller (their dependencies auto-mocked: nothing runs, nothing
 *    connects);
 *  - request body / query schemas: the class-validator rules the global ValidationPipe enforces (dto-openapi-metadata.ts);
 *  - security: `bearer` on every route that runs JwtAuthGuard, none on the public ones;
 *  - response schemas of the client contract endpoints: contract-responses.ts (what the Staff app parses), proved
 *    against live responses by openapi-contract.integration.spec.ts.
 */

export const OPENAPI_DOCUMENT_PATH = path.resolve(__dirname, '../../../../openapi/crewflow-api.openapi.json');
const SRC = path.resolve(__dirname, '../../..');

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') yield* sourceFiles(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/**
 * Every controller class in the application source (files that declare `@Controller(`). The live route table of the real
 * AppModule is compared with the committed document by openapi-contract.integration.spec.ts, so a controller found here
 * but not registered (or the reverse) cannot go unnoticed.
 */
export function collectControllers(): Type<unknown>[] {
  const found = new Map<string, Type<unknown>>();
  for (const file of sourceFiles(SRC)) {
    if (!/@Controller\(/.test(fs.readFileSync(file, 'utf8'))) continue;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    for (const value of Object.values(require(file) as Record<string, unknown>)) {
      if (typeof value === 'function' && Reflect.getMetadata('__controller__', value) === true) found.set(value.name, value as Type<unknown>);
    }
  }
  return [...found.keys()].sort().map((name) => found.get(name)!);
}

/** `Controller.method` → whether the handler runs JwtAuthGuard (controller guards, then handler guards). */
function authenticatedHandlers(controllers: Type<unknown>[]): Map<string, boolean> {
  const scanner = new MetadataScanner();
  const out = new Map<string, boolean>();
  for (const controller of controllers) {
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as Array<Type<CanActivate>>;
    for (const method of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[method] as object;
      const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<Type<CanActivate>>)];
      out.set(`${controller.name}.${method}`, guards.includes(JwtAuthGuard));
    }
  }
  return out;
}

/** Object keys sorted at every depth (array order kept), so the committed file only changes when the API does. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export async function buildOpenApiDocument(): Promise<OpenAPIObject> {
  const controllers = collectControllers();
  const done = new Set<Function>();
  for (const dto of requestDtosOf(controllers)) attachOpenApiMetadata(dto, done);

  const moduleRef = await Test.createTestingModule({ controllers }).useMocker(() => ({})).compile();
  // Same pipe as every Nest application the repository builds (XA-11); nothing is served, the scanner only reads metadata.
  const app = applyGlobalValidationPipe(moduleRef.createNestApplication({ logger: false }));
  const config = new DocumentBuilder()
    .setTitle('Crewflow API')
    .setDescription(
      'Generated from the code by packages/rab-server/src/__tests__/contract/openapi/generate-openapi.ts; do not edit by hand. ' +
        'Request schemas come from the class-validator rules the API enforces; response schemas are given for the client ' +
        'contract endpoints (x-crewflow-contract) and proved against live responses in CI. Not served by the API.',
    )
    .setVersion('v1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}.${methodKey}`,
  });
  await app.close();

  const authenticated = authenticatedHandlers(controllers);
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const isAuthenticated = authenticated.get(operation.operationId ?? '');
      if (isAuthenticated === undefined) throw new Error(`OpenAPI: operation ${operation.operationId} of ${method.toUpperCase()} ${route} has no controller handler`);
      operation.security = isAuthenticated ? [{ bearer: [] }] : [];
      const contract = CONTRACT_RESPONSES[`${method.toUpperCase()} ${route}`];
      if (contract) {
        operation.responses = { ...operation.responses, [contract.status]: { description: contract.description, content: { 'application/json': { schema: contract.schema as SchemaObject } } } };
        (operation as unknown as Record<string, unknown>)['x-crewflow-contract'] = true;
      }
    }
  }
  const missing = Object.keys(CONTRACT_RESPONSES).filter((key) => {
    const [method, route] = key.split(' ') as [string, string];
    return !document.paths[route]?.[method.toLowerCase() as (typeof HTTP_METHODS)[number]];
  });
  if (missing.length) throw new Error(`OpenAPI: contract responses for routes that do not exist: ${missing.join(', ')}`);
  document.components = { ...document.components, schemas: { ...document.components?.schemas, ...(CONTRACT_COMPONENTS as Record<string, SchemaObject>) } };
  return sortKeys(document) as OpenAPIObject;
}

export function serialiseOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
