import { SecurityAuditSink } from '../../engine/core-modules/audit-sink/security-audit-sink';
import {
  describeSemanticDrift,
  readSemanticPosture,
  SemanticDrift,
  semanticDriftFromGolden,
  semanticDriftFromSnapshot,
  SemanticPosture,
  SemanticQuery,
} from './semantic-posture';
import { SEMANTIC_GOLDEN_BY_MAJOR } from './semantic-golden';
import { ownerLoginRolePostureProblems } from '../boot-checks/owner-login-posture';

/**
 * The semantic posture check at boot and on a timer (M0 §6.4 control 4). READ ONLY: it never rewrites, re-grants or
 * repairs a security object — that would let whoever planted the change decide what "repaired" means.
 *
 * Boot (`assertSemanticPostureAtBoot`, called by runDatabaseBootGates on the gate session):
 *   - the object section must equal the committed golden for this PostgreSQL major (semantic-golden.ts); any difference
 *     refuses (the caller exits non-zero, the process never becomes ready);
 *   - no golden for this major: refused in production (fail closed, D4: unsupported major), a WARNING elsewhere;
 *   - returns the snapshot, the baseline for the monitor.
 * Monitor (`SemanticPostureMonitor`, started by the API / Worker after boot):
 *   - every `intervalMs` (default 5 min, minimum 30 s): the full posture (objects, workspaces, roles) is compared with the
 *     boot baseline, and the owner-login role rules (backdoor logins, reachability, inventory) are re-run;
 *   - on drift: `ready()` turns false (the readiness endpoint reports unready, so an orchestrator stops routing / restarts
 *     into the boot refusal), one sanitised alert line is logged and a `security.posture.drift` event goes to the external
 *     audit sink. It stays unready until the process restarts and passes the boot check again (no auto-clear).
 *   - a failed check (database unreachable, timeout) is NOT drift: it is logged and retried on the next tick; readiness is
 *     left to the process's own database health check.
 */
export class SemanticPostureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticPostureError';
  }
}

export interface BootSemanticResult {
  posture: SemanticPosture;
  warnings: string[];
}

export async function assertSemanticPostureAtBoot(
  query: SemanticQuery,
  input: {
    production: boolean;
    label: string;
    golden?: Readonly<Record<number, readonly string[]>>;
  },
): Promise<BootSemanticResult> {
  const posture = await readSemanticPosture(query);
  const golden = (input.golden ?? SEMANTIC_GOLDEN_BY_MAJOR)[posture.serverMajor];
  if (!golden) {
    const message = `no reviewed semantic posture golden for PostgreSQL ${posture.serverMajor} (supported: ${Object.keys(input.golden ?? SEMANTIC_GOLDEN_BY_MAJOR).join(', ') || 'none'})`;
    if (input.production) throw new SemanticPostureError(`the ${input.label} refuses to start: ${message}. Generate and review it before serving production.`);
    return { posture, warnings: [`semantic posture NOT verified at boot: ${message}`] };
  }
  const drifts = semanticDriftFromGolden(posture, golden);
  const warnings: string[] = [];
  if (posture.workspaces.size > 0 && !golden.some((l) => l.startsWith('ws|'))) {
    warnings.push(`semantic posture: the PostgreSQL ${posture.serverMajor} golden has no workspace template; ${posture.workspaces.size} workspace schema(s) not compared (posture golden, RLS gate and fingerprints still apply)`);
  }
  if (drifts.length) {
    throw new SemanticPostureError(
      `the ${input.label} refuses to start: the database's security objects differ from the reviewed posture (policies / functions / triggers / RLS / audit ACL / owners / settings): ${describeSemanticDrift(drifts)}. Do not serve; investigate — never "fix" by regenerating the golden from this database.`,
    );
  }
  return { posture, warnings };
}

export interface SemanticMonitorOptions {
  /** Opens a session for one check (the process's own login) and returns it with its release function. */
  session: () => Promise<{ query: SemanticQuery; release: () => Promise<void> }>;
  baseline: SemanticPosture;
  intervalMs?: number;
  sink?: SecurityAuditSink;
  log?: (line: string) => void;
  processLabel: string;
}

export interface SemanticMonitorState {
  ready: boolean;
  lastCheckAt: Date | null;
  lastDrift: SemanticDrift[];
  lastRoleProblems: string[];
  checks: number;
}

export class SemanticPostureMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly state: SemanticMonitorState = { ready: true, lastCheckAt: null, lastDrift: [], lastRoleProblems: [], checks: 0 };

  constructor(private readonly options: SemanticMonitorOptions) {}

  ready(): boolean {
    return this.state.ready;
  }

  snapshot(): Readonly<SemanticMonitorState> {
    return { ...this.state };
  }

  start(): void {
    if (this.timer) return;
    const interval = Math.max(30_000, this.options.intervalMs ?? 300_000);
    this.timer = setInterval(() => void this.checkOnce(), interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One comparison. Never throws: a failed read is logged and retried next tick. */
  async checkOnce(): Promise<SemanticMonitorState> {
    if (this.running) return this.snapshot();
    this.running = true;
    const log = this.options.log ?? ((line: string) => console.error(line)); // eslint-disable-line no-console
    let session: Awaited<ReturnType<SemanticMonitorOptions['session']>> | null = null;
    try {
      session = await this.options.session();
      const now = await readSemanticPosture(session.query);
      const drift = semanticDriftFromSnapshot(this.options.baseline, now);
      const roleProblems = await ownerLoginRolePostureProblems(session.query);
      this.state.lastCheckAt = new Date();
      this.state.checks += 1;
      if (drift.length || roleProblems.length) {
        this.state.ready = false;
        this.state.lastDrift = drift;
        this.state.lastRoleProblems = roleProblems;
        const detail = [describeSemanticDrift(drift), ...roleProblems].filter(Boolean).join('; ');
        log(`[posture-monitor] SECURITY ALERT ${this.options.processLabel}: the database security posture changed since boot (sha256 ${this.options.baseline.sha256.slice(0, 12)} -> ${now.sha256.slice(0, 12)}): ${detail}. Readiness is now FALSE; nothing was changed back.`);
        await this.options.sink
          ?.emit({
            type: 'security.posture.drift',
            severity: 'critical',
            process: this.options.processLabel,
            detail: { baseline: this.options.baseline.sha256, current: now.sha256, sections: drift.map((d) => d.section), roleProblems: roleProblems.length },
          })
          .catch(() => undefined);
      }
    } catch (error) {
      log(`[posture-monitor] check failed for ${this.options.processLabel} (driver code ${(error as { code?: string })?.code ?? 'unknown'}); retrying on the next tick`);
    } finally {
      if (session) await session.release().catch(() => undefined);
      this.running = false;
    }
    return this.snapshot();
  }
}
