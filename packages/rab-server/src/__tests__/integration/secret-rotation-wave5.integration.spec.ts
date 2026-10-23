import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { SecretEncryptionService } from '../../engine/core-modules/secret-encryption/secret-encryption.service';
import {
  RotationCheckpoint,
  RotationCheckpointStore,
  RowOutcome,
  SecretRotationService,
} from '../../engine/core-modules/secret-encryption/secret-rotation.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 5 lane OPS — `secret:rotate` coverage beyond SMTP: push tokens and the wave-4 TOTP secret, batched, resumable,
 * interruption-safe, with the kid-retirement gate and tamper detection. Disposable database only (DB5's migrations
 * 1786719900000 MFA + 1786719960000 envelope CHECKs applied). Keys are throwaway test strings.
 *
 * TOTP write path: DB5's `core.mfa_rotate_totp_secret` (contract v2, requested by this lane). The fail-closed test hides
 * it for its duration (ALTER FUNCTION … RENAME on this disposable database, restored in `finally` and in afterAll) to
 * prove that a database without the write path keeps the retire gate closed.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const OLD = { kid: 'w5-old', secret: 'wave5-rotation-old-key-material-0123456789' };
const NEW = { kid: 'w5-new', secret: 'wave5-rotation-new-key-material-9876543210' };

class MemoryCheckpoint implements RotationCheckpointStore {
  value: RotationCheckpoint | null = null;
  saves = 0;
  async load() {
    return this.value;
  }
  async save(c: RotationCheckpoint) {
    this.value = JSON.parse(JSON.stringify(c));
    this.saves += 1;
  }
  async clear() {
    this.value = null;
  }
}

describeIfDb('secret:rotate wave 5 — every encrypted column, resumable, retire gate (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let realEnv: EnvironmentService;
  let oldEnc: SecretEncryptionService; // keyring [old], active old
  let newEnc: SecretEncryptionService; // keyring [old, new], active new
  let onlyNewEnc: SecretEncryptionService; // keyring [new], active new — "after the old kid is retired"
  let rotation: SecretRotationService;
  let manager: TestIdentity;
  let orgIds: string[];
  const pushIds: string[] = [];

  const envWith = (keyring: Array<{ kid: string; secret: string }>, active: string) =>
    ({
      get: (key: string) =>
        key === 'APP_ENCRYPTION_KEYRING' ? JSON.stringify(keyring) : key === 'APP_ENCRYPTION_ACTIVE_KID' ? active : realEnv.get(key as never),
    }) as unknown as EnvironmentService;

  async function insertPush(organisationId: string, userId: string, token: string): Promise<string> {
    const id = randomUUID();
    await adminDataSource.query(
      `INSERT INTO core.push_device (id, organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, $4, 'android', $5)`,
      [id, organisationId, userId, `dev-${id}`, oldEnc.encrypt(token)],
    );
    return id;
  }
  const rawPush = async (id: string): Promise<Buffer> =>
    (await adminDataSource.query('SELECT push_token_encrypted AS b FROM core.push_device WHERE id = $1', [id]))[0].b as Buffer;
  const rawTotp = async (userId: string): Promise<Buffer | null> =>
    (await adminDataSource.query('SELECT totp_secret_encrypted AS b FROM core."user" WHERE id = $1', [userId]))[0].b as Buffer | null;
  const rawSmtp = async (orgId: string): Promise<Buffer> =>
    (await adminDataSource.query('SELECT smtp_password_encrypted AS b FROM core.platform_config WHERE organisation_id = $1', [orgId]))[0].b as Buffer;

  const mine = (o: RowOutcome) => orgIds.includes(o.organisationId);
  const hideRotateFn = () => adminDataSource.query('ALTER FUNCTION core.mfa_rotate_totp_secret(uuid, bytea, bytea) RENAME TO mfa_rotate_totp_secret_hidden_by_test');
  const restoreRotateFn = async () => {
    const [{ hidden }] = await adminDataSource.query(`SELECT to_regprocedure('core.mfa_rotate_totp_secret_hidden_by_test(uuid,bytea,bytea)') IS NOT NULL AS hidden`);
    if (hidden) await adminDataSource.query('ALTER FUNCTION core.mfa_rotate_totp_secret_hidden_by_test(uuid, bytea, bytea) RENAME TO mfa_rotate_totp_secret');
  };
  async function collect(options: Parameters<SecretRotationService['rotateAll']>[0]): Promise<RowOutcome[]> {
    const out: RowOutcome[] = [];
    for await (const o of rotation.rotateAll(options)) out.push(o);
    return out;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    realEnv = moduleRef.get(EnvironmentService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    oldEnc = new SecretEncryptionService(envWith([OLD], OLD.kid));
    newEnc = new SecretEncryptionService(envWith([OLD, NEW], NEW.kid));
    onlyNewEnc = new SecretEncryptionService(envWith([NEW], NEW.kid));
    rotation = new SecretRotationService(dataSource, tenantContext, newEnc);

    // Rows from OTHER suites in this database (encrypted under APP_SECRET's `legacy` kid) are rotated too — that is the
    // command's job — so every database-wide assertion below is about the whole database, and per-row ones about ours.
    // Settle them onto the active kid BEFORE our fixtures exist: otherwise the interrupted-apply case (maxRotations: 3,
    // database-wide, id order) can spend its whole budget on other suites' rows and never reach ours, depending only on
    // random organisation ids and on which suites ran earlier. afterAll rotates everything back onto `legacy`.
    for await (const outcome of rotation.rotateAll({ dryRun: false })) void outcome;
    const a = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
    const b = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
    manager = a.managers[0]!;
    orgIds = [a.organisation.id, b.organisation.id];
    for (let i = 0; i < 5; i++) pushIds.push(await insertPush(a.organisation.id, manager.userId, `fcm-token-a-${i}`));
    for (let i = 0; i < 3; i++) pushIds.push(await insertPush(b.organisation.id, b.managers[0]!.userId, `fcm-token-b-${i}`));
    for (const orgId of orgIds) {
      await adminDataSource.query(
        `INSERT INTO core.platform_config (organisation_id, smtp_password_encrypted) VALUES ($1, $2)
         ON CONFLICT (organisation_id) DO UPDATE SET smtp_password_encrypted = EXCLUDED.smtp_password_encrypted`,
        [orgId, oldEnc.encrypt(`smtp-${orgId}`)],
      );
    }
    // TOTP through DB5's own functions, in the user's organisation context (the only write path).
    await tenantContext.runInTenantContext({ organisationId: manager.organisationId, workspaceId: null, userId: manager.userId, role: '' }, async (m) => {
      const [staged] = await m.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [manager.userId, oldEnc.encrypt('JBSWY3DPEHPK3PXP')]);
      expect(staged.ok).toBe(true);
      const step = Math.floor(Date.now() / 1000 / 30);
      const [enabled] = await m.query('SELECT core.mfa_enable_totp($1, $2) AS ok', [manager.userId, step]);
      expect(enabled.ok).toBe(true);
    });
  });

  afterAll(async () => {
    await restoreRotateFn().catch(() => undefined);
    // Self-cleaning. The last test rotates the WHOLE database onto "w5-new", a kid that neither the runtime nor any other
    // suite holds, so every encrypted value other suites wrote would be unreadable to them afterwards. Rotate everything
    // back onto the runtime's implicit `legacy` (APP_SECRET-derived) kid, then remove this suite's own fixtures.
    if (adminDataSource?.isInitialized && rotation) {
      const back = new SecretRotationService(dataSource, tenantContext, new SecretEncryptionService(envWith([OLD, NEW], 'legacy')));
      for await (const outcome of back.rotateAll({ dryRun: false })) void outcome;
      if (pushIds.length > 0) await adminDataSource.query(`DELETE FROM core.push_device WHERE id = ANY($1::uuid[])`, [pushIds]);
      if (orgIds?.length) {
        await adminDataSource.query(`UPDATE core.platform_config SET smtp_password_encrypted = NULL WHERE organisation_id = ANY($1::uuid[])`, [orgIds]);
      }
      if (manager) {
        // Superuser: the only writer besides core.mfa_* that user_mfa_columns_guard admits. No live factor is left behind
        // (MfaTotpRecoveryCodes down() refuses while any exists).
        await adminDataSource.query(
          `UPDATE core."user" SET totp_enabled = false, totp_secret_encrypted = NULL, totp_last_used_step = NULL, mfa_enabled_at = NULL WHERE id = $1`,
          [manager.userId],
        );
      }
    }
    await app.close();
    await adminDataSource.destroy();
  });

  it('dry-run classifies every target and writes nothing', async () => {
    const before = await Promise.all(pushIds.map(rawPush));
    const outcomes = (await collect({ dryRun: true })).filter(mine);
    const byTarget = (t: string) => outcomes.filter((o) => o.target === t);
    expect(byTarget('push_token')).toHaveLength(8);
    expect(byTarget('push_token').every((o) => o.action === 'would-rotate' && o.kid === OLD.kid)).toBe(true);
    expect(byTarget('smtp_password').map((o) => o.action)).toEqual(['would-rotate', 'would-rotate']);
    expect(byTarget('totp_secret')).toEqual([expect.objectContaining({ rowId: manager.userId, action: 'would-rotate', kid: OLD.kid })]);
    const after = await Promise.all(pushIds.map(rawPush));
    after.forEach((b, i) => expect(b.equals(before[i]!)).toBe(true));
  });

  it('verify before rotation: NOT safe to retire the old kid, and the active kid is never retirable', async () => {
    const report = await rotation.verify({ retireKid: OLD.kid });
    expect(report.allOnActiveKid).toBe(false);
    expect(report.retireKid!.safe).toBe(false);
    expect(report.retireKid!.reasons.join('\n')).toMatch(/push_token: \d+ row\(s\) still encrypted under "w5-old"/);
    expect((await rotation.verify({ retireKid: NEW.kid })).retireKid!.reasons).toContain('"w5-new" is the ACTIVE kid');
  });

  it('TOTP on a database WITHOUT the rotate function: apply skips it (unsupported) and the retire gate stays closed (fail closed)', async () => {
    await hideRotateFn();
    try {
      const outcomes = (await collect({ dryRun: false, targets: ['totp_secret'] })).filter(mine);
      expect(outcomes).toEqual([expect.objectContaining({ target: 'totp_secret', action: 'skipped-unsupported' })]);
      expect(oldEnc.inspectKid((await rawTotp(manager.userId))!)).toBe(OLD.kid);
      const report = await rotation.verify({ targets: ['totp_secret'], retireKid: OLD.kid });
      expect(report.targets[0]).toMatchObject({ installed: true, writable: false });
      expect(report.retireKid!.safe).toBe(false);
      expect(report.retireKid!.reasons.join('\n')).toMatch(/totp_secret: rotation write path missing/);
    } finally {
      await restoreRotateFn();
    }
  });

  it('an interrupted apply (max rotations) resumes from its checkpoint and finishes; plaintext survives', async () => {
    const checkpoint = new MemoryCheckpoint();
    const first = await collect({ dryRun: false, targets: ['push_token'], batchSize: 2, checkpoint, maxRotations: 3 });
    expect(first.filter((o) => o.action === 'rotated')).toHaveLength(3);
    expect(checkpoint.value?.position).toEqual(expect.objectContaining({ target: 'push_token' }));
    expect(checkpoint.value?.activeKid).toBe(NEW.kid);
    // Part-way: some of our rows are new, some still old. Never a half-written row.
    const kids = await Promise.all(pushIds.map(async (id) => newEnc.inspectKid(await rawPush(id))));
    expect(kids.filter((k) => k === NEW.kid).length).toBeGreaterThan(0);
    expect(kids.filter((k) => k === OLD.kid).length).toBeGreaterThan(0);

    const second = await collect({ dryRun: false, targets: ['push_token'], batchSize: 2, checkpoint });
    expect(second.filter((o) => o.action === 'rotated').length).toBeGreaterThan(0);
    expect(checkpoint.value).toBeNull(); // completed: checkpoint cleared
    for (const [i, id] of pushIds.entries()) {
      const bytes = await rawPush(id);
      expect(newEnc.inspectKid(bytes)).toBe(NEW.kid);
      expect(onlyNewEnc.decrypt(bytes)).toBe(i < 5 ? `fcm-token-a-${i}` : `fcm-token-b-${i - 5}`);
      expect(() => oldEnc.decrypt(bytes)).toThrow(); // really re-encrypted, not relabelled
    }
  });

  it('an abort signal stops at a batch boundary with a checkpoint; the re-run completes (smtp)', async () => {
    const checkpoint = new MemoryCheckpoint();
    const controller = new AbortController();
    controller.abort();
    const aborted = await collect({ dryRun: false, targets: ['smtp_password'], checkpoint, signal: controller.signal });
    expect(aborted).toHaveLength(0);
    expect(checkpoint.value?.position?.target).toBe('smtp_password');
    await collect({ dryRun: false, targets: ['smtp_password'], checkpoint });
    for (const orgId of orgIds) {
      const bytes = await rawSmtp(orgId);
      expect(newEnc.inspectKid(bytes)).toBe(NEW.kid);
      expect(onlyNewEnc.decrypt(bytes)).toBe(`smtp-${orgId}`);
    }
  });

  it('a checkpoint written for a different active kid is ignored (a new rotation starts from the beginning)', async () => {
    const checkpoint = new MemoryCheckpoint();
    checkpoint.value = { v: 1, activeKid: 'some-other-kid', targets: ['push_token'], position: { target: 'push_token', organisationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', cursor: null }, updatedAt: new Date().toISOString() };
    const outcomes = (await collect({ dryRun: false, targets: ['push_token'], checkpoint })).filter(mine);
    expect(outcomes).toHaveLength(8); // every row seen again (all already active now)
    expect(outcomes.every((o) => o.action === 'skipped-already-active')).toBe(true);
  });

  it('tamper detection: a modified ciphertext is reported unreadable, never rewritten, and blocks retirement', async () => {
    const victim = pushIds[0]!;
    const original = await rawPush(victim);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0x01; // inside the GCM ciphertext: envelope CHECK still passes
    await adminDataSource.query('UPDATE core.push_device SET push_token_encrypted = $2 WHERE id = $1', [victim, tampered]);

    const report = await rotation.verify({ targets: ['push_token'], retireKid: OLD.kid });
    expect(report.targets[0]!.unreadable).toBeGreaterThanOrEqual(1);
    expect(report.unreadableRows).toContainEqual({ target: 'push_token', organisationId: orgIds[0], rowId: victim });
    expect(report.retireKid!.safe).toBe(false);
    const outcomes = (await collect({ dryRun: false, targets: ['push_token'] })).filter((o) => o.rowId === victim);
    expect(outcomes).toEqual([expect.objectContaining({ action: 'skipped-unreadable', classification: 'unreadable' })]);
    expect((await rawPush(victim)).equals(tampered)).toBe(true);

    await adminDataSource.query('UPDATE core.push_device SET push_token_encrypted = $2 WHERE id = $1', [victim, original]); // repair
  });

  it('the envelope CHECK refuses a non-RAB2 value (no plaintext can be stored by any writer)', async () => {
    await expect(
      adminDataSource.query('UPDATE core.push_device SET push_token_encrypted = $2 WHERE id = $1', [pushIds[1], Buffer.from('plaintext-fcm-token-xxxxxxxxxxxxxxxxxxxx')]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it("with DB5's core.mfa_rotate_totp_secret the adapter rotates the ENABLED secret (ciphertext only)", async () => {
    const outcomes = (await collect({ dryRun: false, targets: ['totp_secret'] })).filter(mine);
    expect(outcomes).toEqual([expect.objectContaining({ rowId: manager.userId, action: 'rotated' })]);
    const bytes = (await rawTotp(manager.userId))!;
    expect(onlyNewEnc.decrypt(bytes)).toBe('JBSWY3DPEHPK3PXP');
    const [state] = await adminDataSource.query(
      'SELECT totp_enabled, totp_last_used_step IS NOT NULL AS has_step, mfa_enabled_at IS NOT NULL AS has_enabled_at FROM core."user" WHERE id = $1',
      [manager.userId],
    );
    expect(state).toEqual({ totp_enabled: true, has_step: true, has_enabled_at: true }); // only the ciphertext changed
  });

  it('old-kid retention: after every row is on the new kid, --verify --retire-kid old is SAFE and the new-only keyring reads everything', async () => {
    // Finish whatever other suites left under other kids (whole database), then gate.
    const all = await collect({ dryRun: false });
    expect(all.filter((o) => o.action === 'skipped-unreadable')).toEqual([]);
    const report = await rotation.verify({ retireKid: OLD.kid });
    expect(report.allOnActiveKid).toBe(true);
    expect(report.retireKid).toEqual({ kid: OLD.kid, safe: true, reasons: [] });
    // Simulate the retirement: a service WITHOUT the old kid decrypts every one of our rows.
    for (const id of pushIds) {
      const bytes = await rawPush(id);
      expect(() => onlyNewEnc.decrypt(bytes)).not.toThrow();
    }
    for (const orgId of orgIds) expect(onlyNewEnc.decrypt(await rawSmtp(orgId))).toBe(`smtp-${orgId}`);
    expect(onlyNewEnc.decrypt((await rawTotp(manager.userId))!)).toBe('JBSWY3DPEHPK3PXP');
  });
});
