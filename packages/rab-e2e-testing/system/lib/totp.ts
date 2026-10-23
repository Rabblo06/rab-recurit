import { createHmac } from 'node:crypto';

/** RFC 4648 base32 → bytes. */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`bad base32 char ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — an independent implementation, so the server's is tested, not reused. */
export function totp(secretBase32: string, atMs = Date.now(), stepOffset = 0): string {
  const counter = Math.floor(atMs / 1000 / 30) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

export function secretFromOtpauth(uri: string): string {
  const s = new URL(uri).searchParams.get('secret');
  if (!s) throw new Error('otpauth URI without secret');
  return s;
}

/** Waits until the next 30 s step starts, so a fresh (never-used) code is available. */
export async function waitNextStep(): Promise<void> {
  const ms = 30_000 - (Date.now() % 30_000) + 250;
  await new Promise((r) => setTimeout(r, ms));
}
