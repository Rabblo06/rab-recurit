import type { EntityManager } from 'typeorm';

import { bindBusinessSchema, CORE_BUSINESS_SCHEMA } from '@rab/server/engine/core-modules/tenant/business-tables';
import { WORKSPACE_TABLES } from '@rab/server/database/typeorm/workspace-schema/workspace-tables';

/**
 * Part C2 unit-test fakes (no database). Job code names business tables through `businessTables(manager)`, which only
 * answers for a manager a binder recorded, inside a live transaction. A fake standing in for TenantContextService (or for
 * a TypeORM transaction) therefore has to look like what the real one hands out:
 *
 *  - `asLiveTransactionManager`: a transaction's manager (live query runner). For fakes of `dataSource.transaction`, where
 *    the job binds the schema itself (account-invite-cleanup).
 *  - `asTenantBoundManager`: that, plus the binding TenantContextService records with HWS off (`core`), so statements read
 *    `"core"."<table>"` exactly as they do at runtime in that mode.
 */
export function asLiveTransactionManager<M extends object>(manager: M): M {
  return Object.assign(manager, { queryRunner: { isReleased: false, isTransactionActive: true } });
}

export function asTenantBoundManager<M extends object>(manager: M): M {
  asLiveTransactionManager(manager);
  bindBusinessSchema(manager as unknown as EntityManager, CORE_BUSINESS_SCHEMA, null);
  return manager;
}

const QUALIFIED_CORE_BUSINESS_TABLE = new RegExp(`"core"\\."(${WORKSPACE_TABLES.join('|')})"`, 'g');

/**
 * A statement with every `"core"."<workspace table>"` the primitive wrote turned back into the bare name, so a sha256 pin
 * taken before Part C2 still proves every OTHER byte unchanged. Callers also assert the qualified form is present.
 */
export function withoutCoreBusinessQualifier(sql: string): string {
  return sql.replace(QUALIFIED_CORE_BUSINESS_TABLE, '$1');
}
