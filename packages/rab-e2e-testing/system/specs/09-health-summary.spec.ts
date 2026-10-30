import { expect, test } from '@playwright/test';

import { sql } from '../lib/db';
import { container } from '../lib/stack';
import { updateState } from '../lib/state';

/**
 * Closing check — after every scenario ran: outboxes drained (nothing stuck, nothing failed), and the ERROR/WARN lines the
 * API and the worker wrote during the whole run, grouped by message, so a transient failure cannot hide behind a green UI.
 */
test('7.0 outboxes drained; server/worker error lines grouped', async () => {
  const { spawnSync } = await import('node:child_process');
  const logs = (svc: string) => {
    const r = spawnSync('docker', ['logs', container(svc)], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  };
  const group = (text: string) => {
    const out: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const m = line.match(/\b(ERROR|WARN)\s+\[([A-Za-z]+)\]\s+(.*)$/);
      if (!m) continue;
      const key = `${m[1]} [${m[2]}] ${m[3]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').replace(/\d+/g, 'N').slice(0, 110)}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };
  const email = await sql(`select status, count(*)::int n from core.email_outbox group by 1 order by 1`);
  const realtime = await sql(`select status, count(*)::int n, max(attempt_count)::int max_attempts from core.realtime_event group by 1 order by 1`);
  const routingRefusals = (logs('worker').match(/WorkspaceRoutingError/g) ?? []).length;
  const summary = { email, realtime, server: group(logs('server')), worker: group(logs('worker')), workerRoutingRefusals: routingRefusals };
  updateState((s) => { s.notes.healthSummary = summary; });
  expect(email.every((r: any) => ['SENT', 'CANCELLED'].includes(String(r.status).toUpperCase()))).toBe(true);
  expect(realtime.filter((r: any) => /fail|dead/i.test(r.status))).toEqual([]);
});
