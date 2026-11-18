import type { Client } from 'pg';

import { provisionWorkspaceSchema } from './provision-workspace-schema';
import { resetWorkspaceFingerprintSelectionForTests, workspaceFingerprintMajor, workspaceFingerprintMajorSelected } from './v1/expected-fingerprints';

/**
 * PR #227 (security review L3): the TypeScript provisioner selects the workspace fingerprints of the server its session is
 * on BEFORE its first write, whatever process calls it (the Worker's in-process provisioner never selected one, so on
 * PostgreSQL 17 / 18 every workspace it built failed its fingerprint check against the PostgreSQL 16 table). Fake session:
 * the run is stopped at the first statement after the selection, so nothing past it is reached.
 */
const WORKSPACE = '0b0e6f1e-3c1d-4d58-9e1a-2a7f4e6b8c01';

function fakeClient(serverVersionNum: string) {
  const sent: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      sent.push(text);
      if (/current_setting\('server_version_num'\)/.test(text)) return { rows: [{ num: serverVersionNum }] };
      throw Object.assign(new Error('stop: the first statement after the selection'), { code: 'XX000' });
    }),
  };
  return { client: client as unknown as Client, sent };
}

const isWrite = (sql: string) => /^\s*(BEGIN|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|SELECT\s+set_config|SELECT\s+core\.(begin|register|provision|mark))/i.test(sql);

describe('provisionWorkspaceSchema: the server major is selected before the first write', () => {
  beforeEach(() => resetWorkspaceFingerprintSelectionForTests());
  afterAll(() => resetWorkspaceFingerprintSelectionForTests());

  it('server_version_num 170006: selects 17 as its very first statement, before any write', async () => {
    const { client, sent } = fakeClient('170006');
    expect(workspaceFingerprintMajorSelected()).toBe(false);
    await expect(provisionWorkspaceSchema(client, WORKSPACE)).rejects.toBeDefined();
    expect(sent[0]).toMatch(/current_setting\('server_version_num'\)/);
    expect(workspaceFingerprintMajor()).toBe(17);
    expect(sent.slice(0, 2).filter(isWrite)).toEqual([]);
  });

  it('server_version_num 190000: refused at the selection, nothing else is sent', async () => {
    const { client, sent } = fakeClient('190000');
    await expect(provisionWorkspaceSchema(client, WORKSPACE)).rejects.toThrow(/PostgreSQL 19 is not supported; use 16-18/);
    expect(sent).toHaveLength(1);
    expect(workspaceFingerprintMajorSelected()).toBe(false);
  });

  it('a process that selected another major is refused, never silently switched', async () => {
    await expect(provisionWorkspaceSchema(fakeClient('180001').client, WORKSPACE)).rejects.toBeDefined();
    expect(workspaceFingerprintMajor()).toBe(18);
    const { client, sent } = fakeClient('160015');
    await expect(provisionWorkspaceSchema(client, WORKSPACE)).rejects.toThrow(/cannot switch to 16/);
    expect(sent).toHaveLength(1);
    expect(workspaceFingerprintMajor()).toBe(18);
  });
});
