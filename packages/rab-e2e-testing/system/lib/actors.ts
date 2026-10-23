import { expect } from '@playwright/test';

import { SYNTHETIC_PASSWORD, workspaceHost, workspaceOrigin } from './env';
import { ApiClient, expectStatus } from './http';
import { loadState } from './state';

/** Initial Manager of tenant A/B, signed in on its OWN workspace host (web cookie session, trusted Origin). */
export async function managerFor(t: 'A' | 'B'): Promise<ApiClient> {
  const s = loadState();
  const label = s[t].label!;
  const c = new ApiClient({ host: workspaceHost(label), origin: workspaceOrigin(label), label: `im${t}` });
  expectStatus(await c.login(s[t].imEmail!, SYNTHETIC_PASSWORD), 200, `IM ${t} login on its workspace host`);
  return c;
}

/** A staff member on the mobile transport (X-Client-Platform: mobile + Bearer), talking to the API host directly. */
export async function staffMobile(email: string): Promise<ApiClient> {
  const c = new ApiClient({ host: '127.0.0.1:3300', origin: null, mobile: true, label: `staff ${email}` });
  expectStatus(await c.login(email, SYNTHETIC_PASSWORD, { applicationTarget: 'staff_app' }), 200, `staff login ${email}`);
  expect(c.bearer).toBeTruthy();
  return c;
}
