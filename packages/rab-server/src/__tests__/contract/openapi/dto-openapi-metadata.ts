import 'reflect-metadata';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import { getMetadataStorage, ValidationTypes } from 'class-validator';
import type { ValidationMetadata } from 'class-validator/types/metadata/ValidationMetadata';

// class-transformer keeps its @Type registry in an internal module with no typed entry point of its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as typeof import('class-transformer/types/storage');

/**
 * Build-time only (generate-openapi.ts). The request DTOs carry class-validator decorators, not @nestjs/swagger ones,
 * and the API must not depend on @nestjs/swagger at runtime. So the property schema @nestjs/swagger needs is derived
 * here from the SAME metadata the global ValidationPipe enforces (class-validator) plus the reflected property type
 * and class-transformer's @Type, and attached as the static `_OPENAPI_METADATA_FACTORY` the @nestjs/swagger CLI plugin
 * would otherwise emit at compile time. What the document says a body accepts is therefore what the pipe accepts.
 */

const METADATA_FACTORY_NAME = '_OPENAPI_METADATA_FACTORY'; // @nestjs/swagger/dist/plugin/plugin-constants
const PRIMITIVES: ReadonlySet<unknown> = new Set([String, Number, Boolean, Date, Object, Array, Buffer]);

type PropertyMetadata = Record<string, unknown> & { required: boolean };

function isDtoClass(type: unknown): type is new (...args: unknown[]) => unknown {
  return typeof type === 'function' && !PRIMITIVES.has(type) && type.prototype !== undefined;
}

function validationMetadatas(target: Function): ValidationMetadata[] {
  return getMetadataStorage().getTargetValidationMetadatas(target, '', true, false);
}

/** The class a nested property names through class-transformer's `@Type(() => Nested)`, if any. */
function nestedClassOf(target: Function, property: string): Function | undefined {
  const typeMetadata = defaultMetadataStorage.findTypeMetadata(target, property);
  const nested = typeMetadata?.typeFunction?.();
  return isDtoClass(nested) ? nested : undefined;
}

function primitiveOf(reflected: unknown): Record<string, unknown> {
  if (reflected === Number) return { type: Number };
  if (reflected === Boolean) return { type: Boolean };
  if (reflected === Date) return { type: String, format: 'date-time' };
  if (reflected === String) return { type: String };
  return { type: Object };
}

/** One property's schema from its class-validator rules (each: true rules describe the array items). */
function propertyMetadata(target: Function, property: string, rules: ValidationMetadata[], nestedOut: Set<Function>): PropertyMetadata {
  const reflected = Reflect.getMetadata('design:type', target.prototype, property) as unknown;
  const optional = rules.some((r) => r.type === ValidationTypes.CONDITIONAL_VALIDATION);
  const nested = nestedClassOf(target, property);
  const isArray = reflected === Array || rules.some((r) => r.name === 'isArray' || r.each);
  const item: Record<string, unknown> = nested ? { type: () => nested } : primitiveOf(reflected === Array ? String : reflected);
  if (nested) nestedOut.add(nested);
  const outer: Record<string, unknown> = {};
  const target_ = (rule: ValidationMetadata) => (isArray && rule.each ? item : isArray ? outer : item);
  let typed = false;
  for (const rule of rules) {
    const c = rule.constraints ?? [];
    const into = target_(rule);
    switch (rule.name) {
      case 'isString':
        into.type = String;
        typed = true;
        break;
      case 'isInt':
        into.type = 'integer';
        typed = true;
        break;
      case 'isNumber':
        into.type = Number;
        typed = true;
        break;
      case 'isNumberString':
        into.type = String;
        into.pattern = '^-?\\d+(\\.\\d+)?$';
        break;
      case 'isBoolean':
        into.type = Boolean;
        typed = true;
        break;
      case 'isUuid':
        into.type = String;
        into.format = 'uuid';
        break;
      case 'isEmail':
        into.type = String;
        into.format = 'email';
        break;
      case 'isUrl':
        into.type = String;
        into.format = 'uri';
        break;
      case 'isDateString':
      case 'isIso8601':
        into.type = String;
        into.format = 'date-time';
        break;
      case 'isIn':
        into.enum = [...(c[0] as unknown[])];
        break;
      case 'isEnum':
        into.enum = [...new Set(Object.values(c[0] as Record<string, unknown>).filter((v) => typeof v === 'string' || typeof v === 'number'))];
        break;
      case 'equals':
        into.enum = [c[0]];
        break;
      case 'min':
        into.minimum = c[0];
        break;
      case 'max':
        into.maximum = c[0];
        break;
      case 'minLength':
        into.minLength = c[0];
        break;
      case 'maxLength':
        into.maxLength = c[0];
        break;
      case 'isLength':
        into.minLength = c[0];
        if (c[1] !== undefined) into.maxLength = c[1];
        break;
      case 'isNotEmpty':
        if (into.type === String || reflected === String) into.minLength = Math.max(Number(into.minLength ?? 0), 1);
        break;
      case 'matches':
        into.pattern = c[0] instanceof RegExp ? c[0].source : String(c[0]);
        break;
      case 'arrayMaxSize':
        outer.maxItems = c[0];
        break;
      case 'arrayMinSize':
        outer.minItems = c[0];
        break;
      case 'arrayNotEmpty':
        outer.minItems = Math.max(Number(outer.minItems ?? 0), 1);
        break;
      case 'arrayUnique':
        outer.uniqueItems = true;
        break;
      case 'isObject':
        if (!nested) into.type = Object;
        break;
      default:
        break; // custom validators (e.g. a realistic birth date) add no schema keyword
    }
  }
  if (!typed && !nested && item.type === Object && reflected !== Object && reflected !== Array) Object.assign(item, primitiveOf(reflected));
  // A string-union property (`'a' | 'b'`) reflects as Object; its @IsIn / @IsEnum values say what it really is.
  if (item.type === Object && Array.isArray(item.enum) && item.enum.length > 0) {
    item.type = item.enum.every((v) => typeof v === 'number') ? Number : String;
  }
  // Anything still typed Object is a free-form JSON object (never a reference to a schema named "Object").
  if (item.type === Object) item.type = 'object';
  return isArray ? { required: !optional, ...outer, ...item, isArray: true } : { required: !optional, ...item };
}

/** Attaches the metadata factory to `dto` and to every class it nests, once each. */
export function attachOpenApiMetadata(dto: Function, done: Set<Function> = new Set()): void {
  if (done.has(dto)) return;
  done.add(dto);
  const byProperty = new Map<string, ValidationMetadata[]>();
  for (const rule of validationMetadatas(dto)) {
    if (rule.type === ValidationTypes.WHITELIST && rule.name === undefined) {
      byProperty.set(rule.propertyName, byProperty.get(rule.propertyName) ?? []);
      continue;
    }
    byProperty.set(rule.propertyName, [...(byProperty.get(rule.propertyName) ?? []), rule]);
  }
  const nested = new Set<Function>();
  const properties: Record<string, PropertyMetadata> = {};
  for (const property of [...byProperty.keys()].sort()) properties[property] = propertyMetadata(dto, property, byProperty.get(property)!, nested);
  Object.defineProperty(dto, METADATA_FACTORY_NAME, { value: () => properties, configurable: true });
  for (const child of nested) attachOpenApiMetadata(child, done);
}

/** Every class-typed `@Body()` / `@Query()` argument of every handler of the given controllers. */
export function requestDtosOf(controllers: Iterable<Function>): Function[] {
  const scanner = new MetadataScanner();
  const out = new Set<Function>();
  for (const controller of controllers) {
    for (const method of scanner.getAllMethodNames(controller.prototype)) {
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, { index: number }>;
      const types = (Reflect.getMetadata('design:paramtypes', controller.prototype, method) ?? []) as unknown[];
      for (const [key, arg] of Object.entries(args)) {
        const kind = Number(key.split(':')[0]);
        if (kind !== RouteParamtypes.BODY && kind !== RouteParamtypes.QUERY) continue;
        const type = types[arg.index];
        if (isDtoClass(type)) out.add(type);
      }
    }
  }
  return [...out];
}
