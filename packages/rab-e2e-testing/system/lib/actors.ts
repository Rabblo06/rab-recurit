import { expect } from '@playwright/test';

import { API_DIRECT_HOST, SYNTHETIC_PASSWORD, managerHost, managerOrigin } from './env';
import { ApiClient, expectStatus } from './http';
import { loadState } from './state';

/** Initial Manager of tenant A/B, signed in where it works (its OWN workspace host with host routing; web cookie session, trusted Origin). */
export async function managerFor(t: 'A' | 'B'): Promise<ApiClient> {
  const s = loadState();
  const label = s[t].label!;
  const c = new ApiClient({ host: managerHost(label), origin: managerOrigin(label), label: `im${t}` });
  expectStatus(await c.login(s[t].imEmail!, SYNTHETIC_PASSWORD), 200, `IM ${t} login on its workspace host`);
  return c;
}

/** A staff member on the mobile transport (X-Client-Platform: mobile + Bearer), talking to the API host directly. */
export async function staffMobile(email: string): Promise<ApiClient> {
  const c = new ApiClient({ host: API_DIRECT_HOST, origin: null, mobile: true, label: `staff ${email}` });
  expectStatus(await c.login(email, SYNTHETIC_PASSWORD, { applicationTarget: 'staff_app' }), 200, `staff login ${email}`);
  expect(c.bearer).toBeTruthy();
  return c;
}

/** An unauthenticated mobile client on the API host (activation links, anonymous probes). */
export function anonMobile(label = 'anon'): ApiClient {
  return new ApiClient({ host: API_DIRECT_HOST, origin: null, mobile: true, label });
}
