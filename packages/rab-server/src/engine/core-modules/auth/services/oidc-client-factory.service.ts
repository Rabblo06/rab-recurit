import { Injectable } from '@nestjs/common';
import { Issuer, Client } from 'openid-client';

import { EnvironmentService } from '../../environment/environment.service';

export type OidcProvider = 'google' | 'microsoft';

/**
 * P1C.1B — one maintained OIDC client per provider (`openid-client`, panva/openid-client; chosen
 * specifically so token exchange, PKCE, and ID-token signature verification via the provider's
 * own published JWKS are never hand-rolled — see FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7 and the
 * P1C.1B brief §28). v5 (not v6+) is pinned deliberately: v6 is ESM-only, and `rab-server` runs
 * as CommonJS (`ts-node --transpile-only`, no `"type": "module"`) — see CLAUDE.md's own
 * dual-publish/ts-node gotchas for the same CJS/ESM class of issue elsewhere in this codebase.
 *
 * Discovery (`Issuer.discover`) is a network call to the provider's own `.well-known` endpoint —
 * done once per provider, cached for the process lifetime (both providers' discovery documents
 * are effectively static; a stale cache simply means a future key-rotation needs a restart,
 * which is already true of most long-lived Node processes holding a JWKS cache).
 */
@Injectable()
export class OidcClientFactoryService {
  private clients = new Map<OidcProvider, Promise<Client>>();

  constructor(private readonly env: EnvironmentService) {}

  async getClient(provider: OidcProvider): Promise<Client> {
    let pending = this.clients.get(provider);
    if (!pending) {
      pending = this.discover(provider);
      this.clients.set(provider, pending);
    }
    return pending;
  }

  private async discover(provider: OidcProvider): Promise<Client> {
    if (provider === 'google') {
      const issuer = await Issuer.discover('https://accounts.google.com');
      return new issuer.Client({
        client_id: this.env.get('AUTH_GOOGLE_CLIENT_ID')!,
        client_secret: this.env.get('AUTH_GOOGLE_CLIENT_SECRET')!,
        redirect_uris: [this.env.get('AUTH_GOOGLE_CALLBACK_URL')!],
        response_types: ['code'],
      });
    }

    // AUTH_MICROSOFT_TENANT is fixed to 'organizations' — see environment-variables.ts's own doc
    // comment for why this deliberately diverges from Twenty's 'common' default.
    const tenant = this.env.get('AUTH_MICROSOFT_TENANT');
    const issuer = await Issuer.discover(`https://login.microsoftonline.com/${tenant}/v2.0`);
    return new issuer.Client({
      client_id: this.env.get('AUTH_MICROSOFT_CLIENT_ID')!,
      client_secret: this.env.get('AUTH_MICROSOFT_CLIENT_SECRET')!,
      redirect_uris: [this.env.get('AUTH_MICROSOFT_CALLBACK_URL')!],
      response_types: ['code'],
    });
  }
}
