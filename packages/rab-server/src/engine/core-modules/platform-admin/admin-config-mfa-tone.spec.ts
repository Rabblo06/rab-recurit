import { ForbiddenException } from '@nestjs/common';

import { AdminConfigService } from './admin-config.service';

/**
 * Owner decision 2 (2026-11-21): the Admin panel Security tab's "Force 2FA for any role" row recommends platform admins ON
 * and warns only when platform admins are NOT forced (it used to warn when anyone was forced). Unit-level: the env is a
 * plain map, the platform-admin check is the real assertActivePlatformAdmin over a stub.
 */
const MFA_KEYS = ['AUTH_MFA_ENFORCE_PLATFORM_ADMIN', 'AUTH_MFA_ENFORCE_ORGANISATION_OWNER', 'AUTH_MFA_ENFORCE_INITIAL_MANAGER', 'AUTH_MFA_ENFORCE_OTHER_WEB_USERS'] as const;

function service(env: Record<string, unknown>, isPlatformAdmin = true): AdminConfigService {
  const envService = { get: (key: string) => env[key] };
  const platformAdmin = { isPlatformAdmin: async () => isPlatformAdmin };
  const keyring = { getKeyringSummary: () => ({ activeKid: 'derived-v1', kids: ['derived-v1'] }) };
  return new AdminConfigService(envService as never, {} as never, platformAdmin as never, {} as never, {} as never, keyring as never, keyring as never);
}

async function mfaRow(env: Record<string, unknown>) {
  const { switches } = await service(env).security({ userId: 'u-1' } as never);
  const row = switches.find((s) => s.variable === 'AUTH_MFA_ENFORCE_*');
  expect(row).toBeDefined();
  return row!;
}

describe('AdminConfigService.security(): the MFA enforcement row (owner decision 2)', () => {
  it('platform admins forced: tone ok, state counts the forced classes, the recommendation names the decision', async () => {
    const row = await mfaRow({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true });
    expect(row).toMatchObject({ state: 'On (1)', tone: 'ok', recommended: 'Platform admins on (owner decision); other roles in stages' });
  });

  it('platform admins NOT forced: warn, even when other classes are forced', async () => {
    expect(await mfaRow({})).toMatchObject({ state: 'Off', tone: 'warn' });
    const others = await mfaRow({ AUTH_MFA_ENFORCE_ORGANISATION_OWNER: true, AUTH_MFA_ENFORCE_INITIAL_MANAGER: true, AUTH_MFA_ENFORCE_OTHER_WEB_USERS: true });
    expect(others).toMatchObject({ state: 'On (3)', tone: 'warn' });
  });

  it('every class forced: ok, On (4)', async () => {
    expect(await mfaRow(Object.fromEntries(MFA_KEYS.map((k) => [k, true])))).toMatchObject({ state: 'On (4)', tone: 'ok' });
  });

  it('only a strict true counts (a string "true" is not on)', async () => {
    expect(await mfaRow({ AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'true' })).toMatchObject({ state: 'Off', tone: 'warn' });
  });

  it('a caller who is not a platform admin gets 403 before any setting is read', async () => {
    const env = new Proxy({}, { get: () => { throw new Error('read before the check'); } });
    await expect(service(env as Record<string, unknown>, false).security({ userId: 'u-2' } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
