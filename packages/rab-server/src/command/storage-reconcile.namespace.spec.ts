import { StorageReconcileCommand } from './storage-reconcile.command';

/**
 * Namespace guard for storage reconciliation. A stored_file row may only be read as a delete target when its object key sits under
 * ITS OWN organisation and workspace. These cases need no database: the guard is a pure function of the row's ids and the key.
 */
describe('storage reconcile: object key namespace guard', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const PREFIX = 'rab/';

  function guard(keyPrefix = PREFIX) {
    const env = { get: (name: string) => (name === 'STORAGE_KEY_PREFIX' ? keyPrefix : undefined) };
    const command = new StorageReconcileCommand({} as never, {} as never, env as never, {} as never);
    return (row: { object_key: string; organisation_id: string; workspace_id: string | null }) =>
      (command as unknown as { keyWithinNamespace: (r: typeof row) => boolean }).keyWithinNamespace(row);
  }

  const key = (org: string, ws: string | null, file = 'file.png') =>
    `${PREFIX}organisations/${org}/workspaces/${ws ?? 'none'}/avatars/res-1/${file}`;

  it('accepts a key under the row own organisation and workspace', () => {
    expect(guard()({ object_key: key(ORG_A, WS_A), organisation_id: ORG_A, workspace_id: WS_A })).toBe(true);
  });

  it('accepts an organisation-level row (no workspace) under its own none segment', () => {
    expect(guard()({ object_key: key(ORG_A, null), organisation_id: ORG_A, workspace_id: null })).toBe(true);
  });

  it('refuses a stale row whose key names ANOTHER workspace in the same organisation', () => {
    expect(guard()({ object_key: key(ORG_A, WS_B), organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('refuses a forged row whose key names ANOTHER organisation, even when the workspace segment matches', () => {
    expect(guard()({ object_key: key(ORG_B, WS_A), organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('refuses an organisation-level row whose key points into a workspace', () => {
    expect(guard()({ object_key: key(ORG_A, WS_A), organisation_id: ORG_A, workspace_id: null })).toBe(false);
  });

  it('refuses a key that only shares a prefix with the namespace (prefix collision: org ...1 vs ...11)', () => {
    const collidingOrg = `${ORG_A}1`;
    expect(guard()({ object_key: key(collidingOrg, WS_A), organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('refuses path traversal inside the namespace', () => {
    const base = `${PREFIX}organisations/${ORG_A}/workspaces/${WS_A}/`;
    expect(guard()({ object_key: `${base}../${WS_B}/avatars/x.png`, organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
    expect(guard()({ object_key: `${base}./x.png`, organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
    expect(guard()({ object_key: `${base}a//b.png`, organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('refuses an empty remainder (the namespace itself, with no object)', () => {
    const namespace = `${PREFIX}organisations/${ORG_A}/workspaces/${WS_A}/`;
    expect(guard()({ object_key: namespace, organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('refuses a malformed or foreign-root key with no namespace at all', () => {
    expect(guard()({ object_key: 'etc/passwd', organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
    expect(guard()({ object_key: '', organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('honours the configured key prefix: a key under a different environment prefix is refused', () => {
    expect(guard('staging/')({ object_key: key(ORG_A, WS_A), organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('accepts a legacy key (committed format, no workspace segment) under the row own organisation', () => {
    const legacy = `${PREFIX}organisations/${ORG_A}/avatars/res-1/file.png`;
    expect(guard()({ object_key: legacy, organisation_id: ORG_A, workspace_id: WS_A })).toBe(true);
  });

  it('refuses a legacy-format key that names ANOTHER organisation', () => {
    const legacy = `${PREFIX}organisations/${ORG_B}/avatars/res-1/file.png`;
    expect(guard()({ object_key: legacy, organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });

  it('same filename in two workspaces yields two different namespaces, so no collision', () => {
    const guardA = guard();
    const sameName = 'report.pdf';
    const keyA = key(ORG_A, WS_A, sameName);
    const keyB = key(ORG_A, WS_B, sameName);
    expect(keyA).not.toBe(keyB);
    expect(guardA({ object_key: keyB, organisation_id: ORG_A, workspace_id: WS_A })).toBe(false);
  });
});
