import type { AdminHealthCard } from '../admin-health.service';

/**
 * Phase X Part 2, X2.4 — the API indicator (Twenty: `admin-panel/indicators/app.health.ts:24-44`, the "app" indicator:
 * the process answered, plus its Node version). Crewflow shows the running build (APP_VERSION and, when set, the git
 * commit), the Node version and how long this API process has been up. It is `healthy` whenever it can answer at all:
 * a down API never reaches this code, and an uptime monitor on `/healthz` covers that case (runbook note, X2.4).
 * No database or Redis call.
 */
export function apiIndicator(input: { version: string; commit: string | null; nodeVersion: string; uptimeSeconds: number }): AdminHealthCard {
  const uptime = formatUptime(input.uptimeSeconds);
  const version = /^[A-Za-z0-9._+-]{1,64}$/.test(input.version) ? input.version : 'unknown';
  const commit = input.commit && /^[0-9a-f]{7,40}$/i.test(input.commit) ? input.commit.slice(0, 12) : null;
  return {
    key: 'api',
    status: 'healthy',
    detail: `Version ${version} · Node ${input.nodeVersion} · up ${uptime}`,
    latencyMs: null,
    facts: [
      { label: 'Version', value: version },
      { label: 'Commit', value: commit ?? 'Unknown' },
      { label: 'Node', value: input.nodeVersion },
      { label: 'Process uptime', value: uptime },
    ],
  };
}

export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  if (s < 60) return `${s} s`;
  if (s < 3_600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ${Math.floor((s % 3_600) / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3_600)} h`;
}
