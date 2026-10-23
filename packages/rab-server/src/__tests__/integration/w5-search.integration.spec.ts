import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 5 lane DATA — ranked full-text + trigram search (GET /rest/v1/search). Real PostgreSQL with RLS on
 * (crewflow_app), real HTTP. Asserts ranking, prefix and accent-insensitive matching, the trigram infix fallback,
 * archived exclusion, the email field permission, cross-workspace / cross-organisation zero results and that
 * injection-shaped input is inert (200, never a 500, never extra rows).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const STRONG = 'Correct-Horse-42-battery';

describeIfDb('wave 5: ranked search (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let a: TestIdentity;
  let b: TestIdentity;
  let c: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  const tag = randomUUID().replace(/-/g, '').slice(0, 6); // per-run, letters+digits, keeps runs independent
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const search = (token: string, q: string, limit = 20) => http().get('/rest/v1/search').query({ q, limit }).set(auth(token));
  const names = (res: request.Response, type?: string) =>
    (res.body as Array<{ name: string; type: string }>).filter((r) => !type || r.type === type).map((r) => r.name);

  async function staff(owner: TestIdentity, first: string, last: string): Promise<TestIdentity> {
    const s = await factory.createStaff({ id: owner.organisationId }, { owner, label: `w5s-${first.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}` });
    await admin.query(`UPDATE core."user" SET first_name = $2, last_name = $3 WHERE id = $1`, [s.userId, first, last]);
    return s;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('crewflow:test:invite-rate:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'w5search' });
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    c = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w5search-c' })).managers[0]!;
    [tokenA, tokenB, tokenC] = [await factory.login(a), await factory.login(b), await factory.login(c)];

    ids.zoeExact = (await staff(a, `Zoë${tag}`, `Smith${tag}`)).profileId!;
    ids.zoeLonger = (await staff(a, `Zoe${tag}`, `Smith${tag}son`)).profileId!;
    ids.bob = (await staff(a, `Bob${tag}`, `Zoeller${tag}`)).profileId!;
    const refStaff = await staff(a, `Ref${tag}`, 'Holder');
    ids.ref = refStaff.profileId!;
    await admin.query(`UPDATE core.staff_profile SET staff_ref = $2 WHERE id = $1`, [ids.ref, `QX${tag}77`]);
    ids.archivedStaff = (await staff(a, `Gone${tag}`, 'Leaver')).profileId!;
    await admin.query(`UPDATE core.staff_profile SET employment_status = 'inactive', archived_at = now(), archived_by = $2 WHERE id = $1`, [ids.archivedStaff, a.userId]);
    ids.otherWs = (await staff(b, `Zoë${tag}`, `Otherws${tag}`)).profileId!;
    ids.otherOrg = (await staff(c, `Zoë${tag}`, `Otherorg${tag}`)).profileId!;

    for (const [key, token, name] of [
      ['cafe', tokenA, `Café Rouge ${tag}`],
      ['archivedVenue', tokenA, `Café Archived ${tag}`],
      ['venueB', tokenB, `Café Rouge B ${tag}`],
    ] as const) {
      const res = await http().post('/rest/v1/venues').set(auth(token)).send({ name, type: 'restaurant' });
      expect(res.status).toBe(201);
      ids[key] = res.body.id;
    }
    expect((await http().post(`/rest/v1/venues/${ids.archivedVenue}/archive`).set(auth(tokenA))).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('R1 ranking: the exact (accent-normalised) full name is first, then the other prefix matches', async () => {
    const res = await search(tokenA, `zoe${tag} smith${tag}`);
    expect(res.status).toBe(200);
    const people = names(res, 'Staff');
    expect(people[0]).toBe(`Zoë${tag} Smith${tag}`);
    expect(people).toContain(`Zoe${tag} Smith${tag}son`); // prefix "smith…:*"
    expect(people).not.toContain(`Bob${tag} Zoeller${tag}`);
  });

  it('R2 prefix matching on every term and accent-insensitive in both directions', async () => {
    expect(names(await search(tokenA, `zoe${tag}`), 'Staff').sort()).toEqual([`Zoe${tag} Smith${tag}son`, `Zoë${tag} Smith${tag}`].sort());
    expect(names(await search(tokenA, `ZOË${tag}`), 'Staff')).toHaveLength(2);
    expect(names(await search(tokenA, `cafe rouge ${tag}`), 'Venue')).toEqual([`Café Rouge ${tag}`]);
    expect(names(await search(tokenA, `CAFÉ ${tag}`), 'Venue')).toEqual([`Café Rouge ${tag}`]);
  });

  it('R3 trigram infix fallback for partial names and short identifiers (staff refs)', async () => {
    // "eller<tag>" is inside "Zoeller<tag>" — not a word prefix, so only the trigram index can find it.
    expect(names(await search(tokenA, `eller${tag}`), 'Staff')).toEqual([`Bob${tag} Zoeller${tag}`]);
    expect(names(await search(tokenA, `${tag}77`), 'Staff')).toEqual([`Ref${tag} Holder`]); // infix of the staff ref
    expect(names(await search(tokenA, `qx${tag}`), 'Staff')).toEqual([`Ref${tag} Holder`]); // prefix FTS on the ref vector
  });

  it('R4 archived records are excluded like the default lists', async () => {
    expect(names(await search(tokenA, `gone${tag}`))).toEqual([]);
    expect(names(await search(tokenA, `archived ${tag}`), 'Venue')).toEqual([]);
  });

  it('R5 cross-workspace (same organisation) and cross-organisation: 0 results for the other tenants\' records', async () => {
    const forB = await search(tokenB, `zoe${tag}`);
    expect(names(forB, 'Staff')).toEqual([`Zoë${tag} Otherws${tag}`]);
    expect(names(await search(tokenB, `cafe rouge ${tag}`), 'Venue')).toEqual([`Café Rouge B ${tag}`]);
    const forC = await search(tokenC, `zoe${tag}`);
    expect(names(forC, 'Staff')).toEqual([`Zoë${tag} Otherorg${tag}`]);
    expect(names(await search(tokenC, `cafe ${tag}`))).toEqual([]);
    expect(names(await search(tokenC, `smith${tag}`))).toEqual([]);
  });

  it('R6 injection-shaped input is inert: always 200, never another tenant\'s rows, never a tsquery syntax error', async () => {
    const attempts = [
      `x' OR 1=1 --`,
      `${tag}'); DROP TABLE core.audit_log; --`,
      `zoe${tag}:* | a:*`,
      `!(zoe${tag}) & <-> b`,
      `%${tag}%`,
      `_`,
      `\\`,
      `zoe${tag}\u0000`,
      `pg_catalog.english`,
      `'' || (SELECT email FROM core."user" LIMIT 1) || ''`,
    ];
    for (const q of attempts) {
      const res = await search(tokenA, q);
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
      for (const r of res.body as Array<{ id: string }>) expect([ids.otherWs, ids.otherOrg, ids.venueB]).not.toContain(r.id);
    }
    // A literal % is not a wildcard: it matches nothing here rather than everything.
    expect(names(await search(tokenA, '%'))).toEqual([]);
    const [{ n }] = await admin.query(`SELECT count(*)::int AS n FROM core.audit_log`);
    expect(n).toBeGreaterThan(0);
  });

  it('R7 email: matched (prefix, never returned) for a caller who may see staff email; never for a member whose role hides it', async () => {
    const [{ email }] = await admin.query(`SELECT u.email::text AS email FROM core.staff_profile sp JOIN core."user" u ON u.id = sp.user_id WHERE sp.id = $1`, [ids.bob]);
    const prefix = String(email).slice(0, String(email).indexOf('@') + 3);
    const owner = await search(tokenA, prefix);
    expect(owner.status).toBe(200);
    expect(names(owner, 'Staff')).toEqual([`Bob${tag} Zoeller${tag}`]);
    expect(JSON.stringify(owner.body)).not.toContain(String(email)); // never returned

    // A custom workspace-member whose role shows Staff but leaves the Email field hidden (default).
    const role = await http().post('/rest/v1/roles').set(auth(tokenA)).send({
      name: `Searcher ${tag}`, assignableToMembers: true, readAllObjects: false, objects: [{ object: 'staff', read: 'grant' }],
    });
    expect(role.status).toBe(201);
    const address = `member-${randomUUID().slice(0, 8)}@example.test`;
    const sent = await http().post('/rest/v1/member-invitations').set(auth(tokenA)).send({ emails: [address], roleId: role.body.id });
    expect(sent.status).toBe(200);
    const [inv] = await admin.query(`SELECT id FROM core.member_invitation WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [address]);
    const [mail] = await admin.query(`SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id]);
    const raw = decodeURIComponent(/accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(mail.rendered_html as string)![1]!);
    expect((await http().post('/rest/v1/invitations/accept').send({ token: raw, firstName: 'Mem', lastName: 'Ber', newPassword: STRONG })).status).toBe(200);
    const memberToken = await factory.login({ kind: 'internal_manager', email: address, password: STRONG });

    const byName = await search(memberToken, `bob${tag}`);
    expect(names(byName, 'Staff')).toEqual([`Bob${tag} Zoeller${tag}`]); // the member can see the staff member…
    expect(names(await search(memberToken, prefix), 'Staff')).toEqual([]); // …but cannot find them through the hidden email
  });
});
