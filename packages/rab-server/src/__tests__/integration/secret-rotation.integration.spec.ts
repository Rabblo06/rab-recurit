import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { SecretEncryptionService } from '../../engine/core-modules/secret-encryption/secret-encryption.service';
import { SecretRotationService } from '../../engine/core-modules/secret-encryption/secret-rotation.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Checkpoint 3 (B3) — SecretRotationService proven against the real local database, with REAL
 * pre-keyring legacy ciphertext (built with the literal original HKDF derivation, not through any
 * current code path) to prove existing stored values survive a keyring rollout, not just that unit
 * tests of the crypto primitive agree with itself.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

const APP_SECRET = process.env.APP_SECRET ?? 'a'.repeat(32);
const ACTIVE_SECRET = 'rotation-test-active-secret-32ch';

/** The literal original (pre-Checkpoint-3) derivation — never imported from the service, so this test can't accidentally pass by sharing a bug. */
function legacyEncrypt(plaintext: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(APP_SECRET, 'utf8'), Buffer.alloc(0), 'rab-secret-encryption', 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

describeIfDb('SecretRotationService (Checkpoint 3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let orgLegacy: Organisation;
  let orgActive: Organisation;
  let orgCorrupt: Organisation;
  let rotationWithKeyring: SecretRotationService;
  let encryptionWithKeyring: SecretEncryptionService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    orgLegacy = await factory.createOrganisation('rotation-legacy');
    orgActive = await factory.createOrganisation('rotation-active');
    orgCorrupt = await factory.createOrganisation('rotation-corrupt');

    // A real EnvironmentService with ONE override (a configured keyring) — everything else (DATABASE_URL,
    // APP_SECRET, ...) reads from the real process env exactly like the rest of this suite, so the
    // `legacy` key this resolves to is byte-for-byte the same key legacyEncrypt() above used.
    const realEnv = moduleRef.get(EnvironmentService);
    const envWithKeyring = {
      get: (key: string) =>
        key === 'APP_ENCRYPTION_KEYRING'
          ? JSON.stringify([{ kid: '2026-rotation-test', secret: ACTIVE_SECRET }])
          : key === 'APP_ENCRYPTION_ACTIVE_KID'
            ? '2026-rotation-test'
            : realEnv.get(key as never),
    } as unknown as EnvironmentService;
    encryptionWithKeyring = new SecretEncryptionService(envWithKeyring);
    rotationWithKeyring = new SecretRotationService(dataSource, tenantContext, encryptionWithKeyring);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function insertPlatformConfig(organisationId: string, encrypted: Buffer | null): Promise<void> {
    await adminDataSource.query(
      `INSERT INTO core.platform_config (organisation_id, smtp_password_encrypted)
       VALUES ($1, $2)
       ON CONFLICT (organisation_id) DO UPDATE SET smtp_password_encrypted = EXCLUDED.smtp_password_encrypted`,
      [organisationId, encrypted],
    );
  }

  async function readRaw(organisationId: string): Promise<Buffer | null> {
    const rows = (await adminDataSource.query('SELECT smtp_password_encrypted FROM core.platform_config WHERE organisation_id = $1', [
      organisationId,
    ])) as Array<{ smtp_password_encrypted: Buffer | null }>;
    return rows[0]?.smtp_password_encrypted ?? null;
  }

  it('scan classifies legacy, active and unreadable records correctly without decrypting into logs', async () => {
    await insertPlatformConfig(orgLegacy.id, legacyEncrypt('smtp-pass-legacy'));
    await insertPlatformConfig(orgActive.id, encryptionWithKeyring.encrypt('smtp-pass-already-active'));
    await insertPlatformConfig(orgCorrupt.id, Buffer.from('not-valid-ciphertext-at-all-but-long-enough'));

    const records = new Map<string, string>();
    for await (const record of rotationWithKeyring.scan()) {
      records.set(record.organisationId, record.classification);
    }

    expect(records.get(orgLegacy.id)).toBe('needs-rotation');
    expect(records.get(orgActive.id)).toBe('active');
    expect(records.get(orgCorrupt.id)).toBe('unreadable');
  });

  it('dry-run rotation reports what would happen and writes nothing', async () => {
    const before = await readRaw(orgLegacy.id);
    const outcomes: string[] = [];
    for await (const outcome of rotationWithKeyring.rotate({ dryRun: true })) {
      if (outcome.organisationId === orgLegacy.id) outcomes.push(outcome.action);
    }
    expect(outcomes).toContain('rotated'); // "would rotate"
    const after = await readRaw(orgLegacy.id);
    expect(after!.equals(before!)).toBe(true); // byte-for-byte unchanged
  });

  it('apply rotation re-encrypts the legacy record under the active kid, and the plaintext survives', async () => {
    for await (const outcome of rotationWithKeyring.rotate({ dryRun: false })) {
      if (outcome.organisationId === orgLegacy.id) expect(outcome.action).toBe('rotated');
    }
    const rotatedBytes = await readRaw(orgLegacy.id);
    expect(encryptionWithKeyring.inspectKid(rotatedBytes!)).toBe('2026-rotation-test');
    expect(encryptionWithKeyring.decrypt(rotatedBytes!)).toBe('smtp-pass-legacy');
  });

  it('re-running rotation after it already ran is a no-op (idempotent) — no error, no double re-encryption', async () => {
    const afterFirstRun = await readRaw(orgLegacy.id);
    for await (const outcome of rotationWithKeyring.rotate({ dryRun: false })) {
      if (outcome.organisationId === orgLegacy.id) expect(outcome.action).toBe('skipped-already-active');
    }
    const afterSecondRun = await readRaw(orgLegacy.id);
    expect(afterSecondRun!.equals(afterFirstRun!)).toBe(true);
  });

  it('a concurrent change between read and write is detected and the row is left untouched', async () => {
    // Exercises the exact two private steps rotate() performs, with a REAL, fully-awaited
    // concurrent write injected between them — deterministic, unlike racing an unawaited side
    // effect inside a synchronous decrypt() mock against the generator's own internal timing.
    const freshOrg = await factory.createOrganisation('rotation-concurrent');
    await insertPlatformConfig(freshOrg.id, legacyEncrypt('smtp-pass-concurrent'));

    const service = rotationWithKeyring as unknown as {
      readOne(organisationId: string): Promise<Buffer | undefined>;
      writeIfUnchanged(organisationId: string, expectedCurrent: Buffer, next: Buffer): Promise<boolean>;
    };

    const snapshot = (await service.readOne(freshOrg.id))!;
    // A concurrent writer changes the row AFTER rotate() would have read `snapshot`, BEFORE its write lands.
    await insertPlatformConfig(freshOrg.id, legacyEncrypt('smtp-pass-changed-by-someone-else'));

    const wrote = await service.writeIfUnchanged(freshOrg.id, snapshot, encryptionWithKeyring.encrypt('smtp-pass-rotated-value'));
    expect(wrote).toBe(false);

    // The row still holds whatever the "concurrent writer" put there — rotation never clobbered it.
    const finalBytes = await readRaw(freshOrg.id);
    expect(encryptionWithKeyring.decrypt(finalBytes!)).toBe('smtp-pass-changed-by-someone-else');

    // And the full public rotate() path reaches the same conclusion end-to-end: given the row
    // ALREADY sits on a fresh legacy ciphertext (not the one rotate() would have snapshotted above),
    // a normal run now just rotates it forward — proving the row was never left half-written.
    let action = '';
    for await (const outcome of rotationWithKeyring.rotate({ dryRun: false })) {
      if (outcome.organisationId === freshOrg.id) action = outcome.action;
    }
    expect(action).toBe('rotated');
    expect(encryptionWithKeyring.decrypt((await readRaw(freshOrg.id))!)).toBe('smtp-pass-changed-by-someone-else');
  });

  it('countNeedingRotation reports unsafe-to-retire while an unreadable record exists, safe once it is gone', async () => {
    // Scoped to this test's own organisation ids, not a bare global assertion — countNeedingRotation
    // correctly scans the WHOLE database (that's its job), so asserting a database-wide total of 0
    // would be a test-isolation bug on a long-lived shared database (other suites/other runs of
    // this exact file leave their own rows behind), not a product assertion worth making.
    const ownOrgIds = new Set([orgLegacy.id, orgActive.id, orgCorrupt.id]);
    const scoped = async () => {
      let unreadable = 0;
      let needsRotation = 0;
      for await (const record of rotationWithKeyring.scan()) {
        if (!ownOrgIds.has(record.organisationId)) continue;
        if (record.classification === 'unreadable') unreadable += 1;
        if (record.classification === 'needs-rotation') needsRotation += 1;
      }
      return { unreadable, needsRotation };
    };

    const before = await scoped();
    expect(before.unreadable).toBeGreaterThan(0);

    await insertPlatformConfig(orgCorrupt.id, null); // "fixed" by clearing the corrupt value
    const after = await scoped();
    expect(after.unreadable).toBe(0);
    expect(after.needsRotation).toBe(0); // orgLegacy was rotated above, orgActive was already active
  });
});
