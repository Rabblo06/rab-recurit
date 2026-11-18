/**
 * PR #227 (security review L3): after the gates pass, runDatabaseBootGates selects the workspace fingerprints of the
 * server's major (from the gate report) for the rest of the process: the API, the Worker (its in-process provisioner and
 * drift loop) and the CLI. No database: the connection factory, the gate evaluation and the semantic posture check are
 * replaced; the selection itself is the real one.
 */
const report = (serverVersionNum: number) => ({
  processName: 'worker',
  role: 'crewflow_owner',
  serverVersionNum,
  database: 'crewflow',
  identity: 'unbound',
  tls: false,
  forceRlsTables: 11,
  warnings: [],
  grants: { dueWork: 'ok', dispatchClaims: 'none' },
  dispatchNotify: 'absent',
});
let mockReport = report(170006);

let mockFakeConnection = false;
jest.mock('../postgres', () => {
  const actual = jest.requireActual('../postgres');
  return {
    ...actual,
    // Only while a test runs: other modules call the real factory at import time.
    resolvePgEnvironmentCached: (...args: unknown[]) =>
      mockFakeConnection ? { primary: { source: 'PG_DATABASE_URL', target: { host: 'db' } } } : actual.resolvePgEnvironmentCached(...args),
    createPgDataSource: (...args: unknown[]) =>
      mockFakeConnection
        ? {
            initialize: async () => undefined,
            destroy: async () => undefined,
            migrations: [],
            createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined, query: async () => [] }),
          }
        : actual.createPgDataSource(...args),
  };
});
jest.mock('./database-boot-gate-rules', () => ({
  ...jest.requireActual('./database-boot-gate-rules'),
  evaluateBootGates: async () => mockReport,
}));
jest.mock('../posture-drift/semantic-posture-monitor', () => ({
  ...jest.requireActual('../posture-drift/semantic-posture-monitor'),
  assertSemanticPostureAtBoot: async () => ({ posture: { serverMajor: 0 }, warnings: [] }),
}));

import { DatabaseBootGateError, runDatabaseBootGates } from './database-boot-gates';
import {
  resetWorkspaceFingerprintSelectionForTests,
  selectWorkspaceFingerprintMajor,
  workspaceFingerprintMajor,
  workspaceFingerprintMajorSelected,
} from '../typeorm/workspace-schema/v1/expected-fingerprints';

const run = () => runDatabaseBootGates('worker', { env: { NODE_ENV: 'test' }, log: () => undefined, retry: { attempts: 1 } } as never);

describe('runDatabaseBootGates selects the server major for the process', () => {
  beforeEach(() => {
    resetWorkspaceFingerprintSelectionForTests();
    mockFakeConnection = true;
  });
  afterEach(() => {
    mockFakeConnection = false;
  });
  afterAll(() => resetWorkspaceFingerprintSelectionForTests());

  it.each([
    [160015, 16],
    [170006, 17],
    [180001, 18],
  ])('server_version_num %d in the gate report selects %d', async (num, major) => {
    mockReport = report(num);
    expect(workspaceFingerprintMajorSelected()).toBe(false);
    await expect(run()).resolves.toMatchObject({ serverVersionNum: num });
    expect(workspaceFingerprintMajorSelected()).toBe(true);
    expect(workspaceFingerprintMajor()).toBe(major);
  });

  it('a process that already selected another major is refused at gate "version" (never a silent switch)', async () => {
    selectWorkspaceFingerprintMajor(16);
    mockReport = report(180001);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseBootGateError);
    expect((error as DatabaseBootGateError).gate).toBe('version');
    expect((error as Error).message).toMatch(/cannot switch to 18/);
    expect(workspaceFingerprintMajor()).toBe(16);
  });
});
