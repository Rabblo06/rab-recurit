import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { FieldMetadata, FieldMetadataOption, IndexFieldMetadata, IndexMetadata, ObjectMetadata } from '../entities';

/** No organisation / workspace bound on the transaction: refused before any metadata query (fail closed). */
export class MetadataContextError extends Error {
  constructor() {
    super('metadata reads need a tenant transaction with an organisation and a workspace bound');
    this.name = 'MetadataContextError';
  }
}

export interface FieldMetadataSnapshot extends FieldMetadata {
  options: FieldMetadataOption[];
}

export interface IndexMetadataSnapshot extends IndexMetadata {
  fields: IndexFieldMetadata[];
}

export interface ObjectMetadataSnapshot extends ObjectMetadata {
  fields: FieldMetadataSnapshot[];
  indexes: IndexMetadataSnapshot[];
}

/** Every object of ONE workspace with its fields, options and indexes, in a deterministic order (safe to hash). */
export interface WorkspaceMetadataSnapshot {
  organisationId: string;
  workspaceId: string;
  objects: ObjectMetadataSnapshot[];
}

interface BoundTenant {
  organisationId: string;
  workspaceId: string;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Metadata engine E1: the read side of `core.object_metadata` / `field_metadata` / `field_metadata_option` /
 * `index_metadata` / `index_field_metadata` for later phases (M1-cache builds its entries from readWorkspaceMetadata; M2's
 * diff builder and M3's repository read through it). Read-only: no write path lives here.
 *
 * Every method takes the caller's TENANT transaction (`TenantContextService.runInTenantContext` /
 * `runInWorkspaceContext`). Layers (CLAUDE.md §5.2): this service refuses unless an organisation AND a workspace are bound
 * on that transaction (layer 2, also for jobs and CLI callers that never pass a guard); every query filters on the bound
 * organisation_id AND workspace_id (layer 3); FORCE RLS on all five tables returns nothing outside the binding (layer 4).
 * The tenant ids come from the transaction's own settings, never from an argument, so a caller cannot ask for another
 * workspace's metadata. Reads use `manager` only, so they see the caller's own uncommitted metadata changes.
 *
 * Twenty keeps the same data as in-memory "flat maps" (twentyhq/twenty @ eedb0a73
 * `engine/metadata-modules/flat-object-metadata`, `flat-field-metadata`); Crewflow reads rows and nests them.
 */
@Injectable()
export class MetadataReadService {
  async readWorkspaceMetadata(manager: EntityManager): Promise<WorkspaceMetadataSnapshot> {
    const tenant = await this.boundTenant(manager);
    const where = { organisationId: tenant.organisationId, workspaceId: tenant.workspaceId };
    // Sequential on purpose: one transaction = one connection, and every read must see the same snapshot as the binding.
    const objects = await manager.find(ObjectMetadata, { where });
    const fields = await manager.find(FieldMetadata, { where });
    const options = await manager.find(FieldMetadataOption, { where });
    const indexes = await manager.find(IndexMetadata, { where });
    const indexFields = await manager.find(IndexFieldMetadata, { where });
    return { ...tenant, objects: nest(objects, fields, options, indexes, indexFields) };
  }

  /** One object by its plural API name (case-insensitive, as the unique index), or null. */
  async findObjectByNamePlural(manager: EntityManager, namePlural: string): Promise<ObjectMetadata | null> {
    const tenant = await this.boundTenant(manager);
    return manager
      .createQueryBuilder(ObjectMetadata, 'o')
      .where('o.organisationId = :organisationId AND o.workspaceId = :workspaceId', tenant)
      .andWhere('lower(o.namePlural) = lower(:namePlural)', { namePlural })
      .getOne();
  }

  /** One object by id, or null (an id of another workspace is simply not found). */
  async findObjectById(manager: EntityManager, id: string): Promise<ObjectMetadata | null> {
    const tenant = await this.boundTenant(manager);
    return manager.findOne(ObjectMetadata, { where: { id, organisationId: tenant.organisationId, workspaceId: tenant.workspaceId } });
  }

  private async boundTenant(manager: EntityManager): Promise<BoundTenant> {
    const rows = (await manager.query('SELECT core.current_org()::text AS organisation_id, core.current_workspace()::text AS workspace_id')) as Array<{
      organisation_id: string | null;
      workspace_id: string | null;
    }>;
    const row = rows[0];
    if (!row?.organisation_id || !row.workspace_id) throw new MetadataContextError();
    return { organisationId: row.organisation_id, workspaceId: row.workspace_id };
  }
}

/** Pure: groups the five row sets into objects, sorted (objects by plural name; fields by position then name; ...). */
export function nest(
  objects: readonly ObjectMetadata[],
  fields: readonly FieldMetadata[],
  options: readonly FieldMetadataOption[],
  indexes: readonly IndexMetadata[],
  indexFields: readonly IndexFieldMetadata[],
): ObjectMetadataSnapshot[] {
  const optionsByField = groupBy(options, (o) => o.fieldMetadataId);
  const fieldsByIndex = groupBy(indexFields, (f) => f.indexMetadataId);
  const fieldsByObject = groupBy(fields, (f) => f.objectMetadataId);
  const indexesByObject = groupBy(indexes, (i) => i.objectMetadataId);
  return [...objects]
    .sort((a, b) => byText(a.namePlural, b.namePlural) || byText(a.id, b.id))
    .map((o) => ({
      ...o,
      fields: [...(fieldsByObject.get(o.id) ?? [])]
        .sort((a, b) => a.position - b.position || byText(a.name, b.name) || byText(a.id, b.id))
        .map((f) => ({
          ...f,
          options: [...(optionsByField.get(f.id) ?? [])].sort((a, b) => a.position - b.position || byText(a.value, b.value)),
        })),
      indexes: [...(indexesByObject.get(o.id) ?? [])]
        .sort((a, b) => byText(a.physicalName, b.physicalName))
        .map((i) => ({ ...i, fields: [...(fieldsByIndex.get(i.id) ?? [])].sort((a, b) => a.position - b.position) })),
    }));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}
