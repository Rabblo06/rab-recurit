import { Injectable } from '@nestjs/common';

import { SecurityVersionVector } from '../auth/services/security-version.service';

/**
 * Per-connection state the Stage 3 gateway tracks — nothing more. Deliberately NOT a source of
 * authorization truth: every field here is a COPY of what `JwtAuthGuard` already verified at
 * connect time (or a later heartbeat re-check), never re-derived or trusted independently. See
 * `realtime-gateway.controller.ts`'s own doc comment for the full connection lifecycle.
 */
export interface RealtimeConnectionRecord {
  connectionId: string;
  userId: string;
  organisationId: string;
  workspaceId: string | null;
  sessionId: string;
  transport: 'sse';
  connectedAt: Date;
  lastHeartbeatAt: Date;
  /**
   * Captured at connect time (or last successful heartbeat) — compared against a fresh `readVector()` call to detect
   * mid-connection revocation without redoing the full security-snapshot build. `null` only for the instant between
   * the synchronous slot reservation (C1b: the per-user cap is claimed before the stream opens) and the first async read.
   */
  securityVector: SecurityVersionVector | null;
}

/**
 * Bounded, in-memory, per-API-instance connection tracking. Never consulted as permission
 * authority (`REALTIME_MAX_CONNECTIONS_PER_USER` is the only decision made FROM this registry's
 * own data — everything else is PostgreSQL's job) — this exists purely so a connection's teardown
 * path (disconnect, revocation, heartbeat failure) has something concrete to clean up, and so one
 * user's own fan-out can be bounded. Memory is bounded because every `register()` is paired with
 * exactly one later `unregister()` on the same connection's teardown — never accumulates.
 */
@Injectable()
export class RealtimeConnectionRegistryService {
  private readonly connections = new Map<string, RealtimeConnectionRecord>();

  register(record: RealtimeConnectionRecord): void {
    this.connections.set(record.connectionId, record);
  }

  unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  get(connectionId: string): RealtimeConnectionRecord | undefined {
    return this.connections.get(connectionId);
  }

  touchHeartbeat(connectionId: string, securityVector: SecurityVersionVector): void {
    const record = this.connections.get(connectionId);
    if (record) {
      record.lastHeartbeatAt = new Date();
      record.securityVector = securityVector;
    }
  }

  countForUser(userId: string): number {
    let count = 0;
    for (const record of this.connections.values()) {
      if (record.userId === userId) count++;
    }
    return count;
  }

  /** Total connections across every user — used only for observability/benchmarking, never an authorization decision. */
  get size(): number {
    return this.connections.size;
  }
}
