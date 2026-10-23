import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { EnvironmentService } from '../environment/environment.service';
import { parseKeyringEnvVar } from './keyring.util';

const IV_LENGTH = 12; // AES-GCM standard nonce size
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/**
 * Marks a ciphertext as the versioned (kid-tagged) format introduced by Checkpoint 3. A random
 * legacy IV colliding with these exact 4 bytes has probability 1/2^32 — accepted as negligible;
 * even in that vanishing case, the GCM auth-tag check a few lines later would almost certainly
 * still fail on the garbage "ciphertext" produced by misparsing, so the failure mode is a loud
 * decrypt error, never silent corruption or a wrong plaintext.
 */
const VERSIONED_MAGIC = Buffer.from([0x52, 0x41, 0x42, 0x32]); // "RAB2"
const LEGACY_KID = 'legacy';

interface KeyringEntry {
  kid: string;
  key: Buffer;
}

/**
 * Encrypts sort code, account number, National Insurance number, and TOTP
 * secrets at rest — bank/NI fields carry `{ select: false }` in TypeORM so
 * they never leak through a careless `find()` (rab-workforce-architecture.md
 * §5.4). AES-256-GCM, keys derived via HKDF (never used directly as AES key
 * material).
 *
 * Checkpoint 3 — versioned keyring. Ciphertext format:
 *   v2 (current, written by every new encrypt() call):
 *     MAGIC(4) || kidLen(1) || kid(utf8, kidLen bytes) || iv(12) || authTag(16) || ciphertext
 *   legacy (pre-Checkpoint-3, decrypt-only):
 *     iv(12) || authTag(16) || ciphertext
 * `decrypt()` distinguishes the two by the 4-byte magic prefix — never by guessing based on
 * content. With no APP_ENCRYPTION_KEYRING configured, the only key is the implicit `legacy` one
 * derived from APP_SECRET exactly as before this keyring existed — a deployment that never
 * configures the new vars gets byte-for-byte the same encryption key as before, just wrapped in
 * the versioned envelope on write (which decrypt() has always been able to parse, so this alone
 * changes nothing observable without a rotation).
 */
@Injectable()
export class SecretEncryptionService {
  private readonly keyring: Map<string, Buffer>;
  private readonly activeKid: string;

  constructor(env: EnvironmentService) {
    const secret = env.get('APP_SECRET');
    // Must match the ORIGINAL (pre-keyring) derivation byte-for-byte — 'rab-secret-encryption',
    // never 'rab-secret-encryption:legacy' — or every already-encrypted value (e.g.
    // PlatformConfig.smtpPasswordEncrypted) silently becomes undecryptable the moment this ships.
    const legacyKey = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'rab-secret-encryption', KEY_LENGTH));

    this.keyring = new Map<string, Buffer>([[LEGACY_KID, legacyKey]]);

    const rawKeyring = env.get('APP_ENCRYPTION_KEYRING');
    if (rawKeyring) {
      for (const entry of parseKeyringEnvVar(rawKeyring, 'APP_ENCRYPTION_KEYRING')) {
        if (entry.kid === LEGACY_KID) {
          throw new Error(
            `APP_ENCRYPTION_KEYRING must not define a key with kid "${LEGACY_KID}" — that kid is reserved for the implicit APP_SECRET-derived key.`,
          );
        }
        this.keyring.set(entry.kid, deriveKey(entry.secret, entry.kid));
      }

      const activeKid = env.get('APP_ENCRYPTION_ACTIVE_KID');
      if (!activeKid) {
        throw new Error('APP_ENCRYPTION_ACTIVE_KID is required when APP_ENCRYPTION_KEYRING is set — refusing to guess which key is active.');
      }
      if (!this.keyring.has(activeKid)) {
        throw new Error(`APP_ENCRYPTION_ACTIVE_KID "${activeKid}" is not present in APP_ENCRYPTION_KEYRING.`);
      }
      this.activeKid = activeKid;
    } else {
      this.activeKid = LEGACY_KID;
    }
  }

  encrypt(plaintext: string): Buffer {
    const key = this.keyring.get(this.activeKid)!;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const kidBuf = Buffer.from(this.activeKid, 'utf8');
    return Buffer.concat([VERSIONED_MAGIC, Buffer.from([kidBuf.length]), kidBuf, iv, authTag, ciphertext]);
  }

  /** The active kid new encrypt() calls use — exposed read-only so SecretRotationService can tell "already on the active key" apart from "needs rotation" without a second source of truth. */
  get currentActiveKid(): string {
    return this.activeKid;
  }

  /**
   * Reads which key id a ciphertext is tagged with, WITHOUT decrypting — used by
   * SecretRotationService to classify records (legacy / already-active / needs-rotation /
   * unknown-kid) over a large table without paying for a decrypt+re-encrypt on every row.
   * Still a parse of untrusted stored bytes, so it fails the same way decrypt() would on a
   * truncated/corrupt buffer (thrown error, never a guess).
   */
  inspectKid(encrypted: Buffer): string {
    if (encrypted.length >= VERSIONED_MAGIC.length && encrypted.subarray(0, VERSIONED_MAGIC.length).equals(VERSIONED_MAGIC)) {
      const kidLen = encrypted[VERSIONED_MAGIC.length];
      const kidStart = VERSIONED_MAGIC.length + 1;
      if (kidLen === undefined || encrypted.length < kidStart + kidLen) {
        throw new Error('Cannot inspect: truncated versioned ciphertext header.');
      }
      return encrypted.subarray(kidStart, kidStart + kidLen).toString('utf8');
    }
    return LEGACY_KID;
  }

  decrypt(encrypted: Buffer): string {
    if (encrypted.length >= VERSIONED_MAGIC.length && encrypted.subarray(0, VERSIONED_MAGIC.length).equals(VERSIONED_MAGIC)) {
      return this.decryptVersioned(encrypted);
    }
    return this.decryptLegacy(encrypted);
  }

  private decryptVersioned(encrypted: Buffer): string {
    let offset = VERSIONED_MAGIC.length;
    const kidLen = encrypted[offset];
    offset += 1;
    const kid = encrypted.subarray(offset, offset + kidLen).toString('utf8');
    offset += kidLen;

    const key = this.keyring.get(kid);
    if (!key) {
      throw new Error(`Cannot decrypt: unknown encryption key id "${kid}".`);
    }

    const iv = encrypted.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const ciphertext = encrypted.subarray(offset);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  private decryptLegacy(encrypted: Buffer): string {
    const key = this.keyring.get(LEGACY_KID)!;
    const iv = encrypted.subarray(0, IV_LENGTH);
    const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
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

  /**
   * P2.4 — never returns key material, only the operator-chosen `kid` labels. This is what lets
   * `secret:rotate --check-keyring` report, per-instance, which key this process would encrypt
   * new values under and which kids it can still decrypt — the health check the multi-instance
   * key-rotation runbook (`docs/HANDOFF.md`) requires before flipping `APP_ENCRYPTION_ACTIVE_KID`
   * across a fleet.
   */
  getKeyringSummary(): { activeKid: string; kids: string[] } {
    return { activeKid: this.activeKid, kids: [...this.keyring.keys()] };
  }
}

/** Distinct `info` per kid: two different kids never derive the same key even given the same raw secret by mistake. */
function deriveKey(secret: string, kid: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `rab-secret-encryption:${kid}`, KEY_LENGTH));
}
