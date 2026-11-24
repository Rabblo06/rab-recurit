import 'reflect-metadata';
import { getMetadataStorage, ValidationTypes } from 'class-validator';
import type { ValidationMetadata } from 'class-validator/types/metadata/ValidationMetadata';

// class-transformer keeps its @Type registry in an internal module with no typed entry point of its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as typeof import('class-transformer/types/storage');

/**
 * Build-time only (generate-openapi.ts). OpenAPI 3.0 schemas for the request DTOs, derived from the SAME metadata the
 * global ValidationPipe enforces: class-validator rules, the reflected property type and class-transformer's @Type. What
 * the document says a body or query accepts is therefore what the pipe accepts. No third-party OpenAPI library.
 */

export type Schema = Record<string, unknown>;

const PRIMITIVES: ReadonlySet<unknown> = new Set([String, Number, Boolean, Date, Object, Array, Buffer]);

export function isDtoClass(type: unknown): type is Function {
  return typeof type === 'function' && !PRIMITIVES.has(type) && (type as Function).prototype !== undefined;
}

function primitiveSchema(reflected: unknown): Schema {
  if (reflected === Number) return { type: 'number' };
  if (reflected === Boolean) return { type: 'boolean' };
  if (reflected === Date) return { type: 'string', format: 'date-time' };
  if (reflected === String) return { type: 'string' };
  return {};
}

/** Registers every DTO class it meets as `#/components/schemas/<Name>` and hands out `$ref`s to them. */
export class SchemaRegistry {
  readonly components: Record<string, Schema> = {};
  private readonly names = new Map<Function, string>();

  /** `{ $ref }` to the class's component schema, building it (and every class it nests) on first use. */
  refFor(dto: Function): Schema {
    let name = this.names.get(dto);
    if (!name) {
      name = dto.name;
      for (let n = 2; name in this.components; n++) name = `${dto.name}_${n}`; // two DTO classes with one name
      this.names.set(dto, name);
      this.components[name] = {}; // placeholder: a self-referencing DTO resolves to the same name
      this.components[name] = this.objectSchema(dto);
    }
    return { $ref: `#/components/schemas/${name}` };
  }

  /** The inline object schema of a DTO (query DTOs are expanded into parameters from this). */
  objectSchema(dto: Function): Schema {
    const byProperty = new Map<string, ValidationMetadata[]>();
    for (const rule of getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false)) {
      byProperty.set(rule.propertyName, [...(byProperty.get(rule.propertyName) ?? []), rule]);
    }
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const property of [...byProperty.keys()].sort()) {
      const rules = byProperty.get(property)!;
      properties[property] = this.propertySchema(dto, property, rules);
      if (!rules.some((r) => r.type === ValidationTypes.CONDITIONAL_VALIDATION)) required.push(property);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }

  private propertySchema(dto: Function, property: string, rules: ValidationMetadata[]): Schema {
    const reflected = Reflect.getMetadata('design:type', dto.prototype, property) as unknown;
    const nestedType = defaultMetadataStorage.findTypeMetadata(dto, property)?.typeFunction?.();
    const nested = isDtoClass(nestedType) ? nestedType : undefined;
    const isArray = reflected === Array || rules.some((r) => r.name === 'isArray' || r.each);
    const item: Schema = nested ? this.refFor(nested) : primitiveSchema(reflected === Array ? undefined : reflected);
    const outer: Schema = {};
    for (const rule of rules) {
      const c = rule.constraints ?? [];
      const into = isArray && !rule.each ? outer : item;
      if (nested && into === item && rule.name !== undefined) continue; // a $ref takes no sibling keywords in 3.0
      switch (rule.name) {
        case 'isString':
          into.type = 'string';
          break;
        case 'isInt':
          into.type = 'integer';
          break;
        case 'isNumber':
          into.type = 'number';
          break;
        case 'isNumberString':
          into.type = 'string';
          into.pattern = '^-?\\d+(\\.\\d+)?$';
          break;
        case 'isBoolean':
          into.type = 'boolean';
          break;
        case 'isUuid':
          into.type = 'string';
          into.format = 'uuid';
          break;
        case 'isEmail':
          into.type = 'string';
          into.format = 'email';
          break;
        case 'isUrl':
          into.type = 'string';
          into.format = 'uri';
          break;
        case 'isDateString':
        case 'isIso8601':
          into.type = 'string';
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
          if (into.type === 'string' || reflected === String) into.minLength = Math.max(Number(into.minLength ?? 0), 1);
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
          if (!nested) into.type = 'object';
          break;
        default:
          break; // custom validators (e.g. a realistic birth date) add no schema keyword
      }
    }
    // A string-union property (`'a' | 'b'`) reflects as Object; its @IsIn / @IsEnum values say what it really is.
    if (!nested && item.type === undefined && Array.isArray(item.enum) && item.enum.length > 0) {
      item.type = item.enum.every((v) => typeof v === 'number') ? 'number' : 'string';
    }
    return isArray ? { ...outer, type: 'array', items: item } : item;
  }
}
