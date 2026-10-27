import { PermissionFlagType } from '@rab/shared';

import type { AiPermissionChecker } from '../contracts/tools';
import { AiAccessService, AiActor } from '../services/ai-access.service';

/**
 * The `session` principal of `AiPermissionChecker` (AI Phase 3; the `agent` principal is Phase 6 and is NOT built before
 * EX-3): the signed-in user, every check delegated to AiAccessService — never a cache, a JWT or job data.
 *  - `permissions()`: the tool flags the user held when the turn's tools were bound, read from PostgreSQL by the registry
 *    (`AiToolRegistry.sessionChecker`) in the user's own tenant context. It never grows during a turn.
 *  - `assertStillAllowed(flag?)`: the full fresh re-check (session, account, organisation, AI gates, the turn's model, and
 *    the flag), throwing AiAccessRevokedError to stop the turn.
 *  - `fingerprint()`: the one-statement access fingerprint (`AiAccessService.fingerprint`).
 */
export class AiSessionPermissionChecker implements AiPermissionChecker {
  readonly principal = 'session' as const;

  constructor(
    private readonly actor: AiActor,
    private readonly access: AiAccessService,
    private readonly held: ReadonlySet<PermissionFlagType>,
  ) {}

  permissions(): ReadonlySet<PermissionFlagType> {
    return this.held;
  }

  assertStillAllowed(flag?: PermissionFlagType): Promise<void> {
    return this.access.assertStillAllowed(this.actor, flag);
  }

  fingerprint(): Promise<string> {
    return this.access.fingerprint(this.actor);
  }
}
