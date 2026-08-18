import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { EnvironmentService } from '../environment/environment.service';

const IV_LENGTH = 12; // AES-GCM standard nonce size
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts sort code, account number, National Insurance number, and TOTP
 * secrets at rest — bank/NI fields carry `{ select: false }` in TypeORM so
 * they never leak through a careless `find()` (rab-workforce-architecture.md
 * §5.4). AES-256-GCM, key derived from `APP_SECRET` via HKDF (never used
 * directly as a key — HKDF spreads a single high-entropy secret into
 * per-purpose key material without needing separate secrets for every use).
 */
@Injectable()
export class SecretEncryptionService {
  private readonly key: Buffer;

  constructor(env: EnvironmentService) {
    const secret = env.get('APP_SECRET');
    this.key = Buffer.from(
      hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'rab-secret-encryption', 32),
    );
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  decrypt(encrypted: Buffer): string {
    const iv = encrypted.subarray(0, IV_LENGTH);
    const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Serves a masked display value, e.g. bank details `•••• 4821`, without exposing the full plaintext. */
  decryptAndMask(encrypted: Buffer, visibleChars = 4): string {
    const plain = this.decrypt(encrypted);
    const visible = plain.slice(-visibleChars);
    const masked = '•'.repeat(Math.max(0, plain.length - visibleChars));
    return `${masked}${visible}`;
  }
}
