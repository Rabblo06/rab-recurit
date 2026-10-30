/**
 * Phase B (B4/P5): is the read replica fresh enough to serve a read? Pure (no I/O, injectable clock).
 *
 * Rule (owner-approved): the replica is fresh when its REPLAYED WAL position is at or past a PRIMARY WAL position that was
 * sampled at most PG_DATABASE_REPLICA_MAX_LAG_MS ago. Reasoning: if the replica has replayed everything the primary had
 * written at time t, every commit it can be missing happened after t, so its staleness is at most now − t. That is
 * within the bound until t + maxLag.
 *
 * Mechanics: the probe samples the primary's pg_current_wal_lsn() FIRST (timestamp taken before the query is sent, so
 * the recorded time is never later than the real sampling moment — conservative), then the replica's
 * pg_last_wal_replay_lsn(). Every primary sample the replay position has reached extends `freshUntil` to
 * sample.at + maxLag. Consequences:
 *   - an idle, caught-up replica (replay = primary LSN, nothing new written) is fresh, no matter how old
 *     pg_last_xact_replay_timestamp() is — that timestamp is deliberately never used;
 *   - a paused or slow replica stops reaching new samples, and turns stale maxLag after the newest sample it reached;
 *   - a missing measurement (probe failed, function not permitted, replica not in recovery) never extends freshness, and
 *     markUnknown() ends it immediately: unknown = not fresh = primary.
 */

/** Parses a pg_lsn text value ('16/B374D848') into a comparable bigint. Null for null/garbage (→ not fresh). */
export function parseLsn(text: unknown): bigint | null {
  if (typeof text !== 'string') return null;
  const match = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(text.trim());
  if (!match) return null;
  return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`);
}

interface PrimarySample {
  lsn: bigint;
  at: number;
}

export class ReplicaFreshness {
  private samples: PrimarySample[] = [];
  /** Primary samples the replica has not reached yet, NOT pruned by time (lag reporting only; capped). */
  private unreached: PrimarySample[] = [];
  private freshUntil = 0;
  private lastReplay: bigint | null = null;

  constructor(
    private readonly maxLagMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxLagMs) || maxLagMs <= 0) throw new Error('maxLagMs must be a positive integer');
  }

  /** `at` must be taken BEFORE the primary query was sent. */
  recordPrimarySample(lsn: bigint, at: number): void {
    this.samples.push({ lsn, at });
    this.unreached.push({ lsn, at });
    if (this.unreached.length > 512) this.unreached = this.unreached.slice(-512);
    this.prune();
  }

  /** The replica's replayed position, measured after the primary sample(s) it is compared with. Null = unknown. */
  recordReplay(replay: bigint | null): void {
    this.lastReplay = replay;
    if (replay === null) return;
    for (const sample of this.samples) {
      if (replay >= sample.lsn) this.freshUntil = Math.max(this.freshUntil, sample.at + this.maxLagMs);
    }
    this.unreached = this.unreached.filter((s) => replay < s.lsn);
    this.prune();
  }

  /** Measurement failed or the replica was found unusable: not fresh until a new successful measurement. */
  markUnknown(): void {
    this.freshUntil = 0;
    this.lastReplay = null;
    this.unreached = [];
  }

  isFresh(): boolean {
    return this.now() < this.freshUntil;
  }

  /**
   * Lower bound of the current lag in ms: the age of the oldest primary sample the replica has not replayed. 0 when the
   * last replay position covers every sample. Null when unknown.
   */
  lagEstimateMs(): number | null {
    if (this.lastReplay === null) return null;
    if (this.unreached.length === 0) return 0;
    return Math.max(0, this.now() - this.unreached[0].at);
  }

  /** Keep samples for one lag window (older ones can no longer make the replica fresh), and at most 512 of them. */
  private prune(): void {
    const cutoff = this.now() - this.maxLagMs;
    this.samples = this.samples.filter((s) => s.at >= cutoff);
    if (this.samples.length > 512) this.samples = this.samples.slice(-512);
  }
}
