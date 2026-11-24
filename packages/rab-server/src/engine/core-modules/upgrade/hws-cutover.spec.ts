import { createHash } from 'node:crypto';

import { HWS_CUTOVER_EXPECTED_STATE, HWS_CUTOVER_FUNCTIONS, HWS_CUTOVER_TABLES, hwsCutoverStateProblems } from '../../../database/typeorm/workspace-schema/backfill/hws-cutover-sql';
import { WORKSPACE_TABLE_COPY_ORDER } from '../../../database/typeorm/workspace-schema/backfill/fk-graph';
import { WORKSPACE_TABLES, WORKSPACE_TEMPLATE_TABLES } from '../../../database/typeorm/workspace-schema/provision-workspace-schema';
import { CUTOVER_BACKUP_MARKER_ENV, parseCutoverBackupMarker, verifyCutoverBackup } from './upgrade-commands/0-7/hws-cutover-backup';
import { createHwsCutoverCommand, HWS_CUTOVER_BLOCK_PREFIX, HWS_CUTOVER_NAME, hwsCutoverBlockMarker } from './upgrade-commands/0-7/hws-cutover';
import { HWS_CUTOVER_COPY_ORDER, HWS_CUTOVER_TABLE_LIST } from './upgrade-commands/0-7/hws-cutover-tables';
import { UPGRADE_COMMANDS_0_7 } from './upgrade-commands/0-7';
import { UPGRADE_COMMANDS } from './upgrade-commands/registry';
import type { UpgradeCommandHost } from './upgrade-commands/upgrade-command';
import { commandStepName } from './upgrade-sequence';
import { isUpgradeBlocked, parseUpgradeBlock, upgradeBlockMarker } from './workspace-upgrade-block';
import { cutoverStateRefused } from './hws-cutover-routing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** OWNER-DB-ULTIMATE Part C3 (option A′, pending owner choice): the pure parts of the HWS cutover command. */
describe('C3 HWS cutover: frozen lists stay equal to their sources', () => {
  it('the command table list, the SQL closed list and WORKSPACE_TABLES are the same 21 tables', () => {
    // Owner decision 44: the cutover copies the 21 template tables; tables added by a later structure level (27+) never are.
    expect([...HWS_CUTOVER_TABLE_LIST]).toEqual([...WORKSPACE_TEMPLATE_TABLES]);
    expect([...HWS_CUTOVER_TABLES]).toEqual([...WORKSPACE_TEMPLATE_TABLES]);
    expect(new Set(HWS_CUTOVER_TABLE_LIST).size).toBe(21);
  });

  it('the copy order is the reviewed FK order (backfill/fk-graph.ts)', () => {
    expect([...HWS_CUTOVER_COPY_ORDER]).toEqual([...WORKSPACE_TABLE_COPY_ORDER]);
    expect([...HWS_CUTOVER_COPY_ORDER].sort()).toEqual([...HWS_CUTOVER_TABLE_LIST].sort());
  });

  it('the block marker has the Part D format, so the resolver refuses the workspace (503 "being upgraded")', () => {
    for (const cls of ['HWS_CUTOVER_PENDING', 'HWS_CUTOVER_MISMATCH', 'SQLSTATE_23505']) {
      expect(hwsCutoverBlockMarker(cls)).toBe(upgradeBlockMarker(HWS_CUTOVER_NAME, cls));
      expect(isUpgradeBlocked(hwsCutoverBlockMarker(cls))).toBe(true);
      expect(parseUpgradeBlock(hwsCutoverBlockMarker(cls))).toEqual({ step: HWS_CUTOVER_NAME, errorClass: cls });
      expect(hwsCutoverBlockMarker(cls).startsWith(HWS_CUTOVER_BLOCK_PREFIX)).toBe(true);
    }
    expect(hwsCutoverBlockMarker('bad class; DROP')).toBe(upgradeBlockMarker(HWS_CUTOVER_NAME, 'badclassDROP'));
  });

  it('is registered by release 0.7.0 (owner decision Q8: C3 switched on in its own release), as its only instance command', () => {
    expect(UPGRADE_COMMANDS_0_7.map((c) => c.name)).toEqual([HWS_CUTOVER_NAME]);
    expect(UPGRADE_COMMANDS['0-7']).toBe(UPGRADE_COMMANDS_0_7);
    expect(commandStepName('0.7.0', createHwsCutoverCommand())).toBe('0.7.0_HwsCutover_1786721540100');
  });

  it('the migration self-check accepts exactly the reviewed functions', () => {
    const rows = Object.entries(HWS_CUTOVER_EXPECTED_STATE).map(([fn, state]) => ({ fn, state }));
    expect(Object.keys(HWS_CUTOVER_EXPECTED_STATE).sort()).toEqual([...HWS_CUTOVER_FUNCTIONS].sort());
    expect(hwsCutoverStateProblems(rows, true)).toEqual([]);
    expect(hwsCutoverStateProblems(rows.map((r) => (r.fn.includes('copy_batch') ? { ...r, state: r.state + 'crewflow_app' } : r)), true)).toHaveLength(1);
    expect(hwsCutoverStateProblems(rows.slice(1), true)).toHaveLength(1);
    expect(hwsCutoverStateProblems([...rows, { fn: 'core.hws_cutover_extra()', state: 'x' }], true)).toHaveLength(1);
    expect(hwsCutoverStateProblems([], false)).toEqual([]);
    expect(hwsCutoverStateProblems(rows, false)).toHaveLength(rows.length);
  });
});

describe('C3 HWS cutover: the backup marker (owner rule: no cutover without a verified backup)', () => {
  const DB = 'crewflow_test';
  const NOW = new Date('2026-11-14T12:00:00Z');
  const dump = Buffer.concat([Buffer.from('PGDMP'), Buffer.from('synthetic archive body for the spec')]);
  const sha = createHash('sha256').update(dump).digest('hex');
  const SID = '7300000000000000001';
  const good = { kind: 'crewflow-hws-cutover-backup', version: 1, database: DB, systemIdentifier: SID, takenAt: '2026-11-14T10:00:00Z', format: 'pg_dump-custom', dumpFile: 'pre-cutover.dump', sha256: sha, sizeBytes: dump.length, restoreVerified: true };

  function host(opts: { marker?: unknown; env?: Record<string, string | undefined>; dump?: Buffer | null; markerRaw?: string | null } = {}): UpgradeCommandHost {
    const markerText = opts.markerRaw !== undefined ? opts.markerRaw : JSON.stringify(opts.marker ?? good);
    const file = opts.dump === undefined ? dump : opts.dump;
    return {
      env: opts.env ?? { [CUTOVER_BACKUP_MARKER_ENV]: '/backups/marker.json' },
      hwsRuntimeEnabled: true,
      isAbsolutePath: (p) => p.startsWith('/'),
      siblingPath: (p, f) => `${p.slice(0, p.lastIndexOf('/'))}/${f}`,
      readSmallFile: async (p) => (p === '/backups/marker.json' ? markerText : null),
      fileDigest: async (p) =>
        p === '/backups/pre-cutover.dump' && file ? { sha256: createHash('sha256').update(file).digest('hex'), size: file.length, head: file.subarray(0, 8).toString('latin1') } : null,
    };
  }
  const check = (h: UpgradeCommandHost | undefined, sid: string | null = SID) => verifyCutoverBackup(h, { database: DB, systemIdentifier: sid, dbNow: NOW });

  it('a fresh, complete marker with a matching dump passes', async () => {
    await expect(check(host())).resolves.toEqual({ ok: true, marker: good });
  });

  it.each([
    ['no host', undefined, /no host facts/],
    ['the variable unset', host({ env: {} }), /is not set/],
    ['a relative path', host({ env: { [CUTOVER_BACKUP_MARKER_ENV]: 'marker.json' } }), /absolute path/],
    ['no marker file', host({ markerRaw: null }), /does not exist/],
    ['not JSON', host({ markerRaw: '{nope' }), /not valid JSON/],
    ['an extra field', host({ marker: { ...good, extra: 1 } }), /exactly the fields/],
    ['a missing field', host({ marker: { ...good, restoreVerified: undefined } }), /exactly the fields/],
    ['restore not attested', host({ marker: { ...good, restoreVerified: false } }), /restoreVerified/],
    ['another database', host({ marker: { ...good, database: 'other' } }), /another database/],
    ['another cluster', host({ marker: { ...good, systemIdentifier: '7300000000000000002' } }), /another cluster/],
    ['a cluster id that is not a number', host({ marker: { ...good, systemIdentifier: 'abc' } }), /systemIdentifier/],
    ['older than 24 h', host({ marker: { ...good, takenAt: '2026-11-13T11:59:00Z' } }), /older than 24 hours/],
    ['from the future', host({ marker: { ...good, takenAt: '2026-11-14T12:30:00Z' } }), /in the future/],
    ['a path in dumpFile', host({ marker: { ...good, dumpFile: '../etc/passwd' } }), /bare file name/],
    ['the dump missing', host({ dump: null }), /not next to it/],
    ['a truncated dump', host({ dump: dump.subarray(0, dump.length - 1) }), /size differs/],
    ['not a custom archive', host({ dump: Buffer.concat([Buffer.from('XXXXX'), dump.subarray(5)]) }), /not a pg_dump custom-format/],
    ['a swapped dump of the same size', host({ dump: Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(dump.length - 5, 1)]) }), /sha256 differs/],
    ['a plain-format dump declared', host({ marker: { ...good, format: 'plain' } }), /custom-format/],
    ['an upper-case sha', host({ marker: { ...good, sha256: sha.toUpperCase() } }), /64 lower-case hex/],
  ])('refuses: %s', async (_label, h, reason) => {
    const r = await check(h);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(reason);
  });

  it('the cluster binding: null on both sides only when this login cannot read system_identifier', async () => {
    await expect(check(host({ marker: { ...good, systemIdentifier: null } }), null)).resolves.toMatchObject({ ok: true });
    await expect(check(host({ marker: { ...good, systemIdentifier: null } }), SID)).resolves.toMatchObject({ ok: false });
    await expect(check(host(), null)).resolves.toMatchObject({ ok: false });
  });

  it('the refusal reason never echoes the marker path or its content', async () => {
    const r = await check(host({ marker: { ...good, database: 'secret-db-name' } }));
    expect(JSON.stringify(r)).not.toMatch(/secret-db-name|\/backups\//);
    expect('reason' in parseCutoverBackupMarker('[]')).toBe(true);
  });
});

describe('C3 fail-closed routing gate (security review H-1b, re-check N-2)', () => {
  it('refuses started always; once active, everything that is not verified (missing state included)', () => {
    expect(cutoverStateRefused('started', false)).toBe(true);
    expect(cutoverStateRefused(null, false)).toBe(false);
    expect(cutoverStateRefused(undefined, undefined)).toBe(false);
    expect(cutoverStateRefused('verified', false)).toBe(false);
    expect(cutoverStateRefused('started', true)).toBe(true);
    expect(cutoverStateRefused(null, true)).toBe(true);
    expect(cutoverStateRefused(undefined, true)).toBe(true);
    expect(cutoverStateRefused('anything-else', true)).toBe(true);
    expect(cutoverStateRefused('verified', true)).toBe(false);
  });

  it('N-2: the gate is the one-way database sentinel, never the code registry (pruning 0-7 from registry.ts cannot turn it off)', () => {
    const files = [
      join(__dirname, 'hws-cutover-routing.ts'),
      join(__dirname, '..', 'tenant', 'schema-resolver.service.ts'),
      join(__dirname, '..', 'tenant', 'tenant-context.service.ts'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect({ f, registry: /from\s+'[^']*upgrade-commands\/registry'|UPGRADE_COMMANDS/.test(src) }).toEqual({ f, registry: false });
    }
    expect(readFileSync(files[0]!, 'utf8')).toMatch(/EXISTS \(SELECT 1 FROM core\.hws_cutover_activation\) AS cutover_active/);
    // A registry with a later release but without 0-7 changes nothing: the rule only takes DB facts.
    expect(cutoverStateRefused(null, true)).toBe(true);
  });

  it('N-1: no application code calls a function that writes the cutover state', () => {
    for (const rel of ['../../../modules/manager-workspace/services/manager-workspace.service.ts', '../../../command/seed-ai-demo.command.ts']) {
      expect(readFileSync(join(__dirname, rel), 'utf8')).not.toMatch(/hws_cutover_mark_new_workspace|markNewWorkspaceCutoverVerified|hws_cutover_state/);
    }
  });
});
