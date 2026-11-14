import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { AttendanceModule } from '../attendance.module';
import { AttendanceQrService } from '../services/attendance-qr.service';
import { QrTokenService } from '../services/qr-token.service';

/**
 * QR review L4: `QrTokenService.verify` checks signature / algorithm / issuer / audience only. Since QR expiry moved to
 * the shift (owner decision 0i, the token carries no exp), a verify() result is NOT an accept: only
 * `AttendanceQrService.validateQr` applies the shift-based expiry, the shift and venue/ver checks after it. This guard
 * keeps it that way: the only production file that may call `QrTokenService.verify` is attendance-qr.service.ts, the
 * class is not exported from AttendanceModule, and no other production file derives the QR key itself.
 */
const SERVER_SRC = join(__dirname, '..', '..', '..');
const WORKER_SRC = join(SERVER_SRC, '..', '..', 'rab-worker', 'src');

/** Production files (relative to rab-server/src) that may name QrTokenService at all. */
const MAY_REFERENCE = new Set(['modules/attendance/services/qr-token.service.ts', 'modules/attendance/services/attendance-qr.service.ts', 'modules/attendance/attendance.module.ts']);
/** The one production caller of verify(). */
const VERIFY_CALLER = 'modules/attendance/services/attendance-qr.service.ts';

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return ['node_modules', 'dist', '__tests__'].includes(name) ? [] : files(p);
    return /\.(ts|js|cjs|mjs)$/.test(name) && !/\.(spec|test)\.[cm]?[tj]s$/.test(name) ? [p] : [];
  });
}

const production = [
  ...files(SERVER_SRC).map((p) => ({ id: relative(SERVER_SRC, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })),
  ...files(WORKER_SRC).map((p) => ({ id: `rab-worker/src/${relative(WORKER_SRC, p).split(sep).join('/')}`, text: readFileSync(p, 'utf8') })),
];

/** Comments may mention the key derivation (keyring.util.ts documents it); only code counts. Crude but sufficient here. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const referencesQrTokenService = (text: string) => /\bQrTokenService\b|qr-token\.service/.test(code(text));

describe('QrTokenService.verify has exactly one production caller (QR review L4)', () => {
  it('the scan actually found the attendance sources (the guard is not vacuous)', () => {
    expect(production.map((f) => f.id)).toEqual(expect.arrayContaining([...MAY_REFERENCE]));
    expect(production.some((f) => f.id.startsWith('rab-worker/src/'))).toBe(true);
  });

  it('only the reviewed files name QrTokenService (Worker included)', () => {
    const offenders = production.filter((f) => referencesQrTokenService(f.text) && !MAY_REFERENCE.has(f.id)).map((f) => f.id);
    expect(offenders).toEqual([]);
  });

  it('attendance-qr.service.ts is the only one of them that calls verify()', () => {
    const callers = production.filter((f) => f.id !== 'modules/attendance/services/qr-token.service.ts' && referencesQrTokenService(f.text) && /\.verify\s*\(/.test(f.text)).map((f) => f.id);
    expect(callers).toEqual([VERIFY_CALLER]);
    expect(readFileSync(join(SERVER_SRC, VERIFY_CALLER), 'utf8')).toMatch(/this\.qrTokenService\.verify\(/);
  });

  it('no other production file derives the QR key (HKDF info rab-qr-token-v1) to verify tokens itself', () => {
    const derivers = production.filter((f) => code(f.text).includes('rab-qr-token-v1')).map((f) => f.id);
    expect(derivers).toEqual(['modules/attendance/services/qr-token.service.ts']);
  });

  it('AttendanceModule provides QrTokenService but does not export it (other modules get AttendanceQrService)', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AttendanceModule) as unknown[];
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, AttendanceModule) as unknown[];
    expect(providers).toContain(QrTokenService);
    expect(exports).toContain(AttendanceQrService);
    expect(exports).not.toContain(QrTokenService);
  });
});
