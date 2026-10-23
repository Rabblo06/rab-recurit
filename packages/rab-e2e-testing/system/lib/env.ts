import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Wave 6 lane E2E — settings for the DISPOSABLE system stack (system/docker-compose.e2e.yml). Nothing here may ever point
 * at the dev stack (3000/5173/15432), crewflow-test-db (15436) or a remote database: the guards below refuse to run otherwise.
 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const COMPOSE_FILE = join(REPO_ROOT, 'packages', 'rab-e2e-testing', 'system', 'docker-compose.e2e.yml');
export const COMPOSE_PROJECT = 'crewflow-e2e';

export const API_HOST = '127.0.0.1';
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3300);
export const FRONT_PORT = Number(process.env.E2E_FRONT_PORT ?? 5300);
export const PG_PORT = Number(process.env.E2E_PG_PORT ?? 15470);
export const BASE_DOMAIN = `localhost:${FRONT_PORT}`;
export const DEFAULT_HOST = `127.0.0.1:${FRONT_PORT}`;
export const DEFAULT_ORIGIN = `http://${DEFAULT_HOST}`;
export const workspaceHost = (label: string) => `${label}.${BASE_DOMAIN}`;
export const workspaceOrigin = (label: string) => `http://${workspaceHost(label)}`;

const FORBIDDEN_PORTS = new Set([3000, 5173, 15432, 15436, 5432, 5433]);
for (const p of [API_PORT, FRONT_PORT, PG_PORT]) {
  if (FORBIDDEN_PORTS.has(p)) throw new Error(`e2e: refusing to run against port ${p} (dev / test / native database).`);
}

/** The operator env file of the disposable stack (generated secrets, outside the repo). Required. */
export function stackSecrets(): Record<string, string> {
  const file = process.env.E2E_ENV_FILE;
  if (!file) throw new Error('e2e: set E2E_ENV_FILE to the disposable stack env file (see docker-compose.e2e.yml).');
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export const STATE_FILE = process.env.E2E_STATE_FILE ?? join(tmpdir(), 'crewflow-e2e-w6-state.json');
export const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? join(REPO_ROOT, 'docs', 'evidence', 'w6-e2e');

/** The first platform admin, created by the bootstrap-admin one-off (see docker-compose.e2e.yml). */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'w6.admin@crewflow-e2e.test';

/** One strong password for every synthetic account (synthetic stack only; never a real credential). */
export const SYNTHETIC_PASSWORD = process.env.E2E_SYNTHETIC_PASSWORD ?? 'W6-e2e-Synthetic-Pass-2026!';
export const RUN_ID = process.env.E2E_RUN_ID ?? new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
