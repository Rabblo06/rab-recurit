/**
 * Test-only reader for a PHC-encoded argon2 hash (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`). Used by the XA-10
 * specs to assert the CLAUDE.md floor (argon2id, m >= 19456, t >= 2, p = 1) from the hash actually produced, not from
 * the options passed in. Throws on anything else: a test that cannot read the parameters fails, never passes by default.
 */
export interface Argon2Parameters {
  variant: 'argon2id' | 'argon2i' | 'argon2d';
  version: number;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
  hashB64: string;
}

const PHC = /^\$(argon2id|argon2i|argon2d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export function argon2Parameters(encoded: string): Argon2Parameters {
  const m = PHC.exec(encoded);
  if (!m) throw new Error('not a PHC-encoded argon2 hash');
  return {
    variant: m[1] as Argon2Parameters['variant'],
    version: Number(m[2]),
    memoryKiB: Number(m[3]),
    iterations: Number(m[4]),
    parallelism: Number(m[5]),
    saltB64: m[6],
    hashB64: m[7],
  };
}
