import 'reflect-metadata';
import { NotificationType } from '@rab/shared';
import { INestApplication, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { OPENAPI_DOCUMENT_PATH } from '../contract/openapi/build-openapi-document';
import { CONTRACT_RESPONSES } from '../contract/openapi/contract-responses';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Contract tests for the committed OpenAPI document (packages/rab-server/openapi/crewflow-api.openapi.json).
 *
 *  1. The document describes exactly the API the real AppModule serves: every live route is an operation of the
 *     document and every operation is a live route (the generator reads controller classes from the source tree; this
 *     closes the gap between "declared" and "registered"). ci-server separately fails when the committed file differs
 *     from what the code generates.
 *  2. The client contract endpoints (x-crewflow-contract: what the Staff app parses) answer real requests, made the way
 *     the app makes them, with bodies that validate against the document's response schemas. A renamed, retyped or
 *     dropped field the app relies on fails here, before an installed app breaks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

type Schema = Record<string, unknown>;
interface OpenApiDocument {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>; 'x-crewflow-contract'?: boolean }>>;
  components: { schemas: Record<string, Schema> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A small OpenAPI 3.0 schema validator (the subset the contract schemas use). Returns every violation, with its path. */
function violations(doc: OpenApiDocument, schema: Schema, value: unknown, at = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = doc.components.schemas[name];
    if (!target) return [`${at}: unknown schema ${schema.$ref}`];
    return violations(doc, target, value, at);
  }
  if (value === null) return schema.nullable === true ? [] : [`${at}: null is not allowed`];
  if (Array.isArray(schema.allOf)) {
    const errors = (schema.allOf as Schema[]).flatMap((s) => violations(doc, s, value, at));
    if (errors.length) return errors;
  }
  if (Array.isArray(schema.oneOf)) {
    const results = (schema.oneOf as Schema[]).map((s) => violations(doc, s, value, at));
    const matching = results.filter((r) => r.length === 0).length;
    if (matching !== 1) return [`${at}: matches ${matching} of ${results.length} oneOf alternatives (${results.map((r) => r[0] ?? 'ok').join(' | ')})`];
  }
  const errors: string[] = [];
  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`];
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in record)) errors.push(`${at}.${key}: required`);
    for (const [key, child] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) {
      if (key in record && record[key] !== undefined) errors.push(...violations(doc, child, record[key], `${at}.${key}`));
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${at}: expected array, got ${typeof value}`];
    if (schema.items) value.forEach((item, i) => errors.push(...violations(doc, schema.items as Schema, item, `${at}[${i}]`)));
  } else if (type === 'string') {
    if (typeof value !== 'string') return [`${at}: expected string, got ${typeof value}`];
    if (schema.format === 'uuid' && !UUID.test(value)) errors.push(`${at}: not a uuid: ${value}`);
    if (schema.format === 'date' && !DATE.test(value)) errors.push(`${at}: not a date (YYYY-MM-DD): ${value}`);
    if (schema.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${at}: not an ISO date-time: ${value}`);
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  } else if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at}: expected ${type}, got ${typeof value}`];
    if (type === 'integer' && !Number.isInteger(value)) errors.push(`${at}: not an integer: ${value}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}: ${value}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${at}: expected boolean, got ${typeof value}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  return errors;
}

/** `GET /rest/v1/staff/{id}` keys of every route the live application registers. */
function liveOperations(moduleRef: TestingModule): string[] {
  const scanner = new MetadataScanner();
  const out = new Set<string>();
  for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
    const controller = wrapper.metatype as Type<unknown> | undefined;
    if (!controller) continue;
    const base = ([] as string[]).concat((Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined) ?? '');
    for (const method of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[method] as object;
      const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (paths === undefined) continue;
      const verb = RequestMethod[(Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined) ?? RequestMethod.GET];
      for (const b of base) {
        for (const p of ([] as string[]).concat(paths)) {
          const joined = `/${[b, p].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
          out.add(`${verb} ${joined}`);
        }
      }
    }
  }
  return [...out].sort();
}

describeIfDb('OpenAPI contract: the committed document is the live API, and the client contract endpoints honour it', () => {
  jest.setTimeout(300_000);

  const doc = JSON.parse(fs.readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8')) as OpenApiDocument;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let staff: { email: string; password: string; token: string };
  const exercised = new Set<string>();
  const http = () => request(app.getHttpServer());
  const mobile = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Client-Platform': 'mobile' });

  /** Validates a live response against the document's schema for that operation and status. */
  function expectContract(operation: string, status: number, body: unknown): void {
    const [method, route] = operation.split(' ') as [string, string];
    const schema = doc.paths[route]?.[method.toLowerCase()]?.responses?.[String(status)]?.content?.['application/json']?.schema;
    expect([operation, status, schema === undefined ? 'no contract schema for this status' : 'schema']).toEqual([operation, status, 'schema']);
    expect([operation, violations(doc, schema!, body)]).toEqual([operation, []]);
    exercised.add(operation);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    // One workspace with a venue, a job role, a Staff member holding a pending offer and a past worked shift, and one
    // notification: every contract response then carries real rows, not only empty lists.
    const org = await factory.createOrganisation('oapi');
    const manager = await factory.createInternalManager(org);
    const staffIdentity = await factory.createStaff(org, { owner: manager, label: 'oapi-staff' });
    const ws = manager.workspaceId!;
    const ctx = { organisationId: org.id, workspaceId: ws, userId: manager.userId, role: '' };
    const venue = await tenantContext.runInTenantContext(ctx, (m) => m.save(Venue, { organisationId: org.id, name: 'OpenAPI Hall', workspaceId: ws, createdBy: manager.userId }));
    const [role] = await owner.query(
      `INSERT INTO ${businessTable(ws, 'job_role')} (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, 1500, $3, $4) RETURNING id`,
      [org.id, `Role-${randomUUID().slice(0, 8)}`, manager.userId, ws],
    );
    const start = new Date(Date.now() + 3 * 86_400_000);
    await owner.query(
      `WITH s AS (
         INSERT INTO ${businessTable(ws, 'shift')} (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, workspace_id, status)
         VALUES ($1, $2, $3, $4, $5, 1, 1500, $6, $7, 'offered') RETURNING id),
       a AS (
         INSERT INTO ${businessTable(ws, 'shift_assignment')} (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id)
         SELECT $1, s.id, $8, 'offered', 1500, tstzrange($4, $5, '[)'), $7 FROM s RETURNING id)
       INSERT INTO ${businessTable(ws, 'job_offer')} (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
       SELECT $1, a.id, $8, 'pending', now(), now() + interval '1 day', 6000, $6, $7 FROM a`,
      [org.id, venue.id, role.id, start, new Date(start.getTime() + 4 * 3_600_000), manager.userId, ws, staffIdentity.profileId],
    );
    await owner.query(
      `WITH s AS (
         INSERT INTO ${businessTable(ws, 'shift')} (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, filled_count, pay_rate_pence, created_by, workspace_id, status)
         VALUES ($1, $2, $3, now() - interval '400 days', now() - interval '400 days' + interval '4 hours', 1, 1, 1500, $4, $5, 'completed')
         RETURNING id, starts_at, ends_at),
       a AS (
         INSERT INTO ${businessTable(ws, 'shift_assignment')} (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id)
         SELECT $1, s.id, $6, 'completed', 1500, tstzrange(s.starts_at, s.ends_at, '[)'), $5 FROM s RETURNING id, shift_id)
       INSERT INTO ${businessTable(ws, 'attendance')} (organisation_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence, workspace_id)
       SELECT $1, a.id, a.shift_id, $6, now() - interval '400 days', now() - interval '400 days' + interval '4 hours', 'clocked_out', 240, 6000, $5 FROM a`,
      [org.id, venue.id, role.id, manager.userId, ws, staffIdentity.profileId],
    );
    await tenantContext.runInTenantContext(ctx, (m) =>
      moduleRef.get(NotificationService).notify(m, { organisationId: org.id, userId: staffIdentity.userId, type: NotificationType.OFFER_SENT, title: 'New shift offer', message: 'OpenAPI Hall, in three days.' }),
    );
    staff = { email: staffIdentity.email, password: staffIdentity.password, token: '' };
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('the committed document has exactly the live route table (no undocumented route, no documented ghost)', () => {
    const live = liveOperations(moduleRef);
    const documented = Object.entries(doc.paths)
      .flatMap(([route, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${route}`))
      .sort();
    expect(live.length).toBeGreaterThan(300);
    expect({ undocumented: live.filter((k) => !documented.includes(k)), ghosts: documented.filter((k) => !live.includes(k)) }).toEqual({ undocumented: [], ghosts: [] });
  });

  it('the contract operations in the document are exactly the ones contract-responses.ts declares', () => {
    const marked = Object.entries(doc.paths)
      .flatMap(([route, item]) => Object.entries(item).filter(([, op]) => op['x-crewflow-contract'] === true).map(([method]) => `${method.toUpperCase()} ${route}`))
      .sort();
    expect(marked).toEqual(Object.keys(CONTRACT_RESPONSES).sort());
  });

  it('POST /auth/login (Staff app): the session the app stores, refresh token included', async () => {
    const res = await http().post('/rest/v1/auth/login').set('X-Client-Platform', 'mobile').send({ email: staff.email, password: staff.password });
    expectContract('POST /rest/v1/auth/login', res.status, res.body);
    expect(typeof res.body.refreshToken).toBe('string');
    staff.token = res.body.accessToken as string;
  });

  it('GET /auth/me', async () => {
    const res = await http().get('/rest/v1/auth/me').set(mobile(staff.token));
    expectContract('GET /rest/v1/auth/me', res.status, res.body);
    expect(res.body.roles).toContain('staff');
  });

  it('GET /offers/mine: the keyset page the app reads, and the bare array older apps read', async () => {
    const page = await http().get('/rest/v1/offers/mine?scope=all&limit=50').set(mobile(staff.token));
    expectContract('GET /rest/v1/offers/mine', page.status, page.body);
    expect(page.body.data).toHaveLength(1);
    const legacy = await http().get('/rest/v1/offers/mine').set(mobile(staff.token));
    expectContract('GET /rest/v1/offers/mine', legacy.status, legacy.body);
    expect(legacy.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /attendance/me/active and /attendance/me/history (page and bare array)', async () => {
    const active = await http().get('/rest/v1/attendance/me/active').set(mobile(staff.token));
    expectContract('GET /rest/v1/attendance/me/active', active.status, active.body);
    expect(active.body.attendance).toBeNull();
    const page = await http().get('/rest/v1/attendance/me/history?limit=20').set(mobile(staff.token));
    expectContract('GET /rest/v1/attendance/me/history', page.status, page.body);
    expect(page.body.data).toHaveLength(1);
    const legacy = await http().get('/rest/v1/attendance/me/history').set(mobile(staff.token));
    expectContract('GET /rest/v1/attendance/me/history', legacy.status, legacy.body);
    expect(legacy.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /notifications and /notifications/unread-count', async () => {
    const list = await http().get('/rest/v1/notifications').set(mobile(staff.token));
    expectContract('GET /rest/v1/notifications', list.status, list.body);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const count = await http().get('/rest/v1/notifications/unread-count').set(mobile(staff.token));
    expectContract('GET /rest/v1/notifications/unread-count', count.status, count.body);
    expect(count.body.count).toBeGreaterThanOrEqual(1);
  });

  it('GET /payroll/me/payslips', async () => {
    const res = await http().get('/rest/v1/payroll/me/payslips').set(mobile(staff.token));
    expectContract('GET /rest/v1/payroll/me/payslips', res.status, res.body);
  });

  it('the validator itself refuses a broken body (a contract test that cannot fail proves nothing)', () => {
    const schema = { $ref: '#/components/schemas/ContractCurrentUser' };
    expect(violations(doc, schema, { id: 'x', email: 'a@b', firstName: 'A', lastName: 'B', organisationId: randomUUID(), roles: 'staff' })).toEqual([
      '$.id: not a uuid: x',
      '$.roles: expected array, got string',
    ]);
    expect(violations(doc, schema, { id: randomUUID() })).toEqual(expect.arrayContaining(['$.email: required', '$.roles: required']));
  });

  it('every contract operation was exercised by this suite', () => {
    expect([...exercised].sort()).toEqual(Object.keys(CONTRACT_RESPONSES).sort());
  });
});
