import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { QueryResult } from 'typeorm/query-runner/QueryResult';

import { coreDataSourceOptions } from '../../../database/typeorm/core/core.datasource';
import { WORKSPACE_TABLES } from '../../../database/typeorm/workspace-schema/provision-workspace-schema';
import { Attendance, AttendanceCorrection, ShiftReport } from '../../../modules/attendance/entities';
import { User, UserNote } from '../../../modules/identity/entities';
import { ManagerVenue } from '../../../modules/manager/entities';
import { JobOffer, ReplacementRequest } from '../../../modules/offer/entities';
import { JobRole, Shift, ShiftAssignment, ShiftRequestStaff, VenueRoleRate } from '../../../modules/scheduling/entities';
import { StaffProfile } from '../../../modules/staff/entities';
import { Venue } from '../../../modules/venue/entities';
import { AfterCommitPublisher } from '../after-commit/after-commit-publisher';
import { memoRunnerFor } from '../permissions/tx-permission-memo';
import {
  assertBindableSchema,
  bindEntityManagerToSchema,
  boundSchemaOf,
  executingDataSourceOf,
  metadataSourceFor,
  SCHEMA_BOUND_METADATA_CACHE_MAX,
  SchemaBoundEntityManagerError,
} from './schema-bound-entity-manager';

/**
 * Part C2-1 unit level (no database): the SQL TypeORM 0.3.31 generates through a schema-bound manager, captured from a
 * QueryRunner whose `query` records instead of connecting. The real database run is
 * __tests__/integration/c2-1-schema-bound-entities.integration.spec.ts.
 */
const WS = 'workspace_0123456789abcdef0123456789abcdef';
const WS2 = 'workspace_fedcba9876543210fedcba9876543210';
const ID = '00000000-0000-4000-8000-000000000001';
const ENTITIES = [Attendance, AttendanceCorrection, ShiftReport, UserNote, ManagerVenue, JobOffer, ReplacementRequest, JobRole, Shift, ShiftAssignment, ShiftRequestStaff, VenueRoleRate, StaffProfile, Venue];

async function baseDataSource(): Promise<DataSource> {
  // Entities only: reading `.entities` never touches the connection getters of coreDataSourceOptions.
  const ds = new DataSource({ type: 'postgres', entities: coreDataSourceOptions.entities });
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return ds;
}

/** A transactional manager on `base` whose runner records SQL and answers with canned rows (never connects). */
function recordingManager(base: DataSource): { manager: EntityManager; runner: QueryRunner; log: string[] } {
  const log: string[] = [];
  const runner = base.driver.createQueryRunner('master');
  Object.assign(runner, { isTransactionActive: true });
  (runner as unknown as { query: unknown }).query = async (sql: string, _params: unknown[], structured?: boolean) => {
    log.push(sql);
    const rows: Record<string, unknown>[] = /^INSERT/i.test(sql) ? [{ id: ID, created_at: new Date(), updated_at: new Date(), default_rate_pence: '0' }] : [];
    const result = new QueryResult();
    result.records = rows;
    result.raw = /^(UPDATE|DELETE)/i.test(sql) ? [rows, 0] : rows;
    result.affected = 0;
    return structured ? result : rows;
  };
  return { manager: base.createEntityManager(runner), runner, log };
}

describe('schema-bound EntityManager (C2-1)', () => {
  let base: DataSource;
  beforeAll(async () => {
    base = await baseDataSource();
  });

  it('accepts only "core" or workspace_<32 lowercase hex>', () => {
    expect(() => assertBindableSchema('core')).not.toThrow();
    expect(() => assertBindableSchema(WS)).not.toThrow();
    for (const bad of ['public', 'workspace_abc', `${WS}, core`, WS.toUpperCase(), `${WS}"`, '', 'core ', `"${WS}"`, null, 42]) {
      expect(() => assertBindableSchema(bad)).toThrow(SchemaBoundEntityManagerError);
    }
  });

  it('refuses outside an open transaction, and refuses a bad schema before anything is built', async () => {
    await expect(bindEntityManagerToSchema(base.manager, WS)).rejects.toThrow(/open transaction/);
    const { manager } = recordingManager(base);
    await expect(bindEntityManagerToSchema(manager, 'public')).rejects.toThrow(SchemaBoundEntityManagerError);
    expect(boundSchemaOf(manager)).toBeNull();
  });

  it('the 14 workspace entities take the bound schema; every core entity keeps "core"; the base metadata is untouched', async () => {
    const source = await metadataSourceFor(base, WS);
    const workspace = new Set<string>(WORKSPACE_TABLES);
    for (const metadata of source.entityMetadatas) {
      const expected = workspace.has(metadata.tableName) ? WS : 'core';
      expect([metadata.name, metadata.tablePath]).toEqual([metadata.name, `${expected}.${metadata.tableName}`]);
    }
    for (const target of ENTITIES) {
      expect(source.getMetadata(target).tablePath).toBe(`${WS}.${base.getMetadata(target).tableName}`);
      // hws-startup-guard check 3 still holds on the shared DataSource.
      expect(base.getMetadata(target).schema).toBeUndefined();
      expect(base.getMetadata(target).tablePath).toBe(base.getMetadata(target).tableName);
    }
    expect(source.getMetadata(User).tablePath).toBe('core.user');
    expect(source.entityMetadatas).toHaveLength(base.entityMetadatas.length);
  });

  it('find / findOne / relations / query builder joins / save / insert / update / delete all emit "<schema>"."<table>"', async () => {
    const { manager, runner, log } = recordingManager(base);
    const m = await bindEntityManagerToSchema(manager, WS);
    expect(m).not.toBe(manager);
    expect(runner.manager).toBe(m); // persistence and nested transactions use it
    expect(boundSchemaOf(m)).toBe(WS);
    expect(executingDataSourceOf(m)).toBe(base);
    expect(executingDataSourceOf(manager)).toBe(base);

    for (const target of ENTITIES) await m.find(target as never, { take: 1 } as never);
    await m.findOne(StaffProfile, { where: { id: ID }, relations: { jobRole: true, user: true } });
    await m
      .createQueryBuilder(StaffProfile, 'sp')
      .leftJoinAndSelect('sp.jobRole', 'jr')
      .innerJoin(Shift, 's', 's.id = sp.id')
      .leftJoin(Venue, 'v', 'v.id = s.venueId')
      .getMany();
    await m.createQueryBuilder().select('s.id').from('shift', 's').getRawMany();
    await m.update(Shift, { id: ID }, { notes: 'x' });
    await m.delete(UserNote, { id: ID });
    await m.insert(JobRole, { organisationId: ID, name: 'x', defaultRatePence: 0 });
    await m.save(m.create(JobRole, { organisationId: ID, name: 'y', defaultRatePence: 0 }));
    await m.createQueryBuilder().update(Attendance).set({ breakMinutes: 1 }).where('id = :id', { id: ID }).execute();
    await m.transaction((nested) => nested.count(ShiftAssignment));

    const q = `"${WS}"`;
    for (const target of ENTITIES) expect(log.join('\n')).toContain(`FROM ${q}."${base.getMetadata(target).tableName}"`);
    expect(log.join('\n')).toContain(`LEFT JOIN ${q}."job_role" "StaffProfile__StaffProfile_jobRole"`);
    expect(log.join('\n')).toContain(`LEFT JOIN "core"."user" "StaffProfile__StaffProfile_user"`);
    expect(log.join('\n')).toContain(`LEFT JOIN ${q}."job_role" "jr"`);
    expect(log.join('\n')).toContain(`INNER JOIN ${q}."shift" "s"`);
    expect(log.join('\n')).toContain(`LEFT JOIN ${q}."venue" "v"`);
    expect(log.join('\n')).toContain(`FROM ${q}."shift" "s"`);
    expect(log.join('\n')).toContain(`UPDATE ${q}."shift" SET`);
    expect(log.join('\n')).toContain(`DELETE FROM ${q}."user_note"`);
    expect(log.filter((s) => s.startsWith(`INSERT INTO ${q}."job_role"`))).toHaveLength(2);
    expect(log.join('\n')).toContain(`UPDATE ${q}."attendance" SET`);
    // No statement names one of the 14 tables without the schema.
    for (const sql of log) expect(sql).not.toMatch(/(FROM|JOIN|INTO|UPDATE) "(attendance|attendance_correction|shift_report|user_note|manager_venue|job_offer|replacement_request|job_role|shift|shift_assignment|shift_request_staff|venue_role_rate|staff_profile|venue)"/);
  });

  it('fails closed on escape paths: the metadata source has no connection, re-binding to another schema is refused', async () => {
    const { manager } = recordingManager(base);
    const m = await bindEntityManagerToSchema(manager, WS);
    await expect(m.connection.manager.find(Shift)).rejects.toThrow(/not Connected/i);
    expect(m.connection.isInitialized).toBe(false);
    await expect(bindEntityManagerToSchema(m, WS2)).rejects.toThrow(/different schema/);
    expect(await bindEntityManagerToSchema(m, WS)).toBe(m);
    await expect(metadataSourceFor(m.connection, WS)).rejects.toThrow(/itself a schema-bound/);
  });

  it('caches one metadata source per (DataSource, schema), shares a concurrent first build, and evicts least recently used', async () => {
    const own = await baseDataSource();
    const [x, y] = await Promise.all([metadataSourceFor(own, WS), metadataSourceFor(own, WS)]);
    expect(x).toBe(y);
    expect(await metadataSourceFor(own, WS2)).not.toBe(x);
    expect(await metadataSourceFor(base, WS)).not.toBe(x); // per base DataSource (primary vs replica)
    for (let i = 0; i < SCHEMA_BOUND_METADATA_CACHE_MAX; i++) {
      await metadataSourceFor(own, `workspace_${i.toString(16).padStart(32, '0')}`);
    }
    expect(await metadataSourceFor(own, WS)).not.toBe(x); // evicted and rebuilt
  });

  it('two managers bound to different schemas never share metadata (no process-global mutation)', async () => {
    const one = await bindEntityManagerToSchema(recordingManager(base).manager, WS);
    const two = await bindEntityManagerToSchema(recordingManager(base).manager, WS2);
    expect(one.connection.getMetadata(Shift).tablePath).toBe(`${WS}.shift`);
    expect(two.connection.getMetadata(Shift).tablePath).toBe(`${WS2}.shift`);
    expect(one.connection.getMetadata(Shift)).not.toBe(two.connection.getMetadata(Shift));
    expect(base.getMetadata(Shift).tablePath).toBe('shift');
  });

  it('consumers that compare or subscribe to the executing DataSource see the real one, not the metadata source', async () => {
    const { manager, runner } = recordingManager(base);
    const m = await bindEntityManagerToSchema(manager, WS);
    // Permission memo: still memoised on the primary's open transaction.
    expect(memoRunnerFor(m, base)).toBe(runner);
    expect(memoRunnerFor(m, await baseDataSource())).toBeNull();
    // After-commit tasks subscribe where TypeORM broadcasts the commit (queryRunner.connection), never the metadata source.
    const publisher = new AfterCommitPublisher({ maxPerTransaction: 5, maxInFlight: 5, failureMessage: (name) => name, logger: { warn: () => undefined } });
    expect(publisher.defer(m, async () => undefined)).toBe(true);
    expect(base.subscribers.length).toBeGreaterThan(0);
    expect(m.connection.subscribers).toHaveLength(0);
  });

  it('an entity-less DataSource (raw-SQL harness) binds an empty metadata source; entity calls still fail as before', async () => {
    const bare = new DataSource({ type: 'postgres', entities: [] });
    const { manager } = recordingManager(bare);
    const m = await bindEntityManagerToSchema(manager, WS);
    expect(boundSchemaOf(m)).toBe(WS);
    expect(m.connection.entityMetadatas).toHaveLength(0);
    await expect(m.findOne(Shift, { where: { id: ID } })).rejects.toThrow(/No metadata/);
  });
});
