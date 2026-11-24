import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { CanActivate, HttpStatus, RequestMethod, Type } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { CONTRACT_COMPONENTS, CONTRACT_RESPONSES } from './contract-responses';
import { isDtoClass, Schema, SchemaRegistry } from './dto-schema';

/**
 * Build-time only: the OpenAPI 3.0 document of the HTTP API, generated from the code by this repository's own small
 * generator (no third-party OpenAPI library). Never imported by the application: `src/__tests__/**` is outside the app
 * build, and openapi-build-time-only.spec.ts pins that nothing serves a document. The document is a CI artefact
 * (ci-server `openapi` uploads it), never committed.
 *
 * Read from the code:
 *  - routes, methods, path parameters, query parameters and request bodies: the controllers' Nest metadata (the same
 *    `path` / `method` / `__routeArguments__` metadata Nest's router reads);
 *  - request body and query schemas: the class-validator rules the global ValidationPipe enforces (dto-schema.ts);
 *  - success status: `@HttpCode`, else Nest's default (201 for POST, 200 otherwise);
 *  - security: `bearer` on every route that runs JwtAuthGuard, none on the public ones;
 *  - response schemas of the client contract endpoints: contract-responses.ts (what the Staff app parses), proved
 *    against live responses by openapi-contract.integration.spec.ts.
 */

const SRC = path.resolve(__dirname, '../../..');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiOperation {
  operationId: string;
  tags: string[];
  parameters: Schema[];
  requestBody?: Schema;
  responses: Record<string, Schema>;
  security: Array<Record<string, string[]>>;
  'x-crewflow-contract'?: boolean;
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components: { securitySchemes: Record<string, Schema>; schemas: Record<string, Schema> };
}

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
 * Every controller class in the application source (files that declare `@Controller(`). openapi-contract.integration
 * .spec.ts compares the document with the live route table of the real AppModule, so a controller found here but not
 * registered (or the reverse) cannot go unnoticed.
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

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** `/rest/v1/staff/{id}` from a controller path and a handler path. */
function openApiPath(base: string, sub: string): string {
  const joined = `/${[base, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  return joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

interface RouteArgument {
  kind: number;
  data: unknown;
  type: unknown;
}

function routeArguments(controller: Type<unknown>, method: string): RouteArgument[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, { index: number; data?: unknown }>;
  const types = (Reflect.getMetadata('design:paramtypes', controller.prototype, method) ?? []) as unknown[];
  return Object.entries(args)
    .filter(([key]) => /^\d+:\d+$/.test(key)) // built-in decorators only (custom ones such as @AuthUser are not HTTP input)
    .map(([key, arg]) => ({ kind: Number(key.split(':')[0]), data: arg.data, type: types[arg.index] }))
    .sort((a, b) => a.kind - b.kind);
}

function operationFor(controller: Type<unknown>, method: string, routePath: string, verb: HttpMethod, registry: SchemaRegistry): OpenApiOperation {
  const handler = (controller.prototype as Record<string, unknown>)[method] as object;
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as Array<Type<CanActivate>>),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<Type<CanActivate>>),
  ];
  const parameters: Schema[] = [...routePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({ in: 'path', name: m[1], required: true, schema: { type: 'string' } }));
  let requestBody: Schema | undefined;
  for (const arg of routeArguments(controller, method)) {
    if (arg.kind === RouteParamtypes.QUERY) {
      if (arg.data === undefined && isDtoClass(arg.type)) {
        const object = registry.objectSchema(arg.type);
        const required = new Set((object.required as string[] | undefined) ?? []);
        for (const [name, schema] of Object.entries(object.properties as Record<string, Schema>)) {
          parameters.push({ in: 'query', name, required: required.has(name), schema });
        }
      } else if (typeof arg.data === 'string') {
        parameters.push({ in: 'query', name: arg.data, required: false, schema: { type: 'string' } });
      }
    } else if (arg.kind === RouteParamtypes.BODY && requestBody === undefined) {
      const schema = arg.data === undefined && isDtoClass(arg.type) ? registry.refFor(arg.type) : { type: 'object' };
      requestBody = { required: true, content: { 'application/json': { schema } } };
    } else if (arg.kind === RouteParamtypes.FILE || arg.kind === RouteParamtypes.FILES) {
      requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } };
    }
  }
  const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
  const status = String(httpCode ?? (verb === 'post' ? HttpStatus.CREATED : HttpStatus.OK));
  const sse = Reflect.getMetadata(SSE_METADATA, handler) === true;
  return {
    operationId: `${controller.name}.${method}`,
    tags: [controller.name.replace(/Controller$/, '')],
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: {
      [status]: sse ? { description: 'Server-Sent Events stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } } : { description: '' },
    },
    security: guards.includes(JwtAuthGuard) ? [{ bearer: [] }] : [],
  };
}

/** Object keys sorted at every depth (array order kept), so two runs on the same code give byte-identical output. */
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

/** `$ref`s that name a component the document does not have. */
function danglingRefs(document: OpenApiDocument): string[] {
  const refs = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (k === '$ref' && typeof child === 'string') refs.add(child);
        else walk(child);
      }
    }
  };
  walk(document);
  return [...refs].filter((ref) => !(ref.replace('#/components/schemas/', '') in document.components.schemas)).sort();
}

export function buildOpenApiDocument(): OpenApiDocument {
  const registry = new SchemaRegistry();
  const scanner = new MetadataScanner();
  const paths: OpenApiDocument['paths'] = {};
  for (const controller of collectControllers()) {
    const bases = asArray(Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined);
    for (const method of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[method];
      if (typeof handler !== 'function') continue;
      const subs = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (subs === undefined) continue;
      const verb = RequestMethod[(Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined) ?? RequestMethod.GET].toLowerCase() as HttpMethod;
      if (!HTTP_METHODS.includes(verb)) throw new Error(`OpenAPI: ${controller.name}.${method} uses ${verb.toUpperCase()}, which the generator does not describe`);
      for (const base of bases.length ? bases : ['']) {
        for (const sub of asArray(subs)) {
          const route = openApiPath(base, sub);
          if (paths[route]?.[verb]) throw new Error(`OpenAPI: two handlers for ${verb.toUpperCase()} ${route}`);
          const operation = operationFor(controller, method, route, verb, registry);
          const contract = CONTRACT_RESPONSES[`${verb.toUpperCase()} ${route}`];
          if (contract) {
            operation.responses = { ...operation.responses, [contract.status]: { description: contract.description, content: { 'application/json': { schema: contract.schema } } } };
            operation['x-crewflow-contract'] = true;
          }
          (paths[route] ??= {})[verb] = operation;
        }
      }
    }
  }
  const missing = Object.keys(CONTRACT_RESPONSES).filter((key) => {
    const [verb, route] = key.split(' ') as [string, string];
    return !paths[route]?.[verb.toLowerCase() as HttpMethod];
  });
  if (missing.length) throw new Error(`OpenAPI: contract responses for routes that do not exist: ${missing.join(', ')}`);
  const collisions = Object.keys(CONTRACT_COMPONENTS).filter((name) => name in registry.components);
  if (collisions.length) throw new Error(`OpenAPI: contract components collide with DTO schemas: ${collisions.join(', ')}`);
  const document: OpenApiDocument = {
    openapi: '3.0.3',
    info: {
      title: 'Crewflow API',
      version: 'v1',
      description:
        'Generated from the code by packages/rab-server/src/__tests__/contract/openapi/generate-openapi.ts (a CI artefact, ' +
        'never committed and never served). Request schemas come from the class-validator rules the API enforces; response ' +
        'schemas are given for the client contract endpoints (x-crewflow-contract) and proved against live responses in CI.',
    },
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { ...registry.components, ...CONTRACT_COMPONENTS },
    },
  };
  const dangling = danglingRefs(document);
  if (dangling.length) throw new Error(`OpenAPI: $ref to missing schemas: ${dangling.join(', ')}`);
  return sortKeys(document) as OpenApiDocument;
}

export function serialiseOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
