import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Wave 6 lane E2E — settings for the DISPOSABLE system stack (system/docker-compose.e2e.yml). Nothing here may ever point
 * at the dev stack (3000/5173/15432), crewflow-test-db (15436) or a remote database: the guards below refuse to run otherwise.
 *
 * Two modes, each its own compose project, ports and volumes, so both can exist side by side:
 *   parity  (DEFAULT) production's committed runtime flags (docker-compose.production.yml): HWS runtime routing OFF (business
 *           rows in the shared `core` tables), no workspace host routing, no subdomain origin trust, no login handoff,
 *           AI off, the provisioner on. Project `crewflow-parity`; API 3400, console 5400, Postgres 15480, Redis 16480.
 *   devlike the dev stack's flags (packages/rab-docker/docker-compose.yml): HWS ON, workspace hosts (*.localhost), origin
 *           trust and the login handoff ON. Project `crewflow-e2e`; API 3300, console 5300, Postgres 15470, Redis 16470.
 */
export type E2eMode = 'parity' | 'devlike';
const MODES: Record<E2eMode, { project: string; api: number; front: number; pg: number }> = {
  parity: { project: 'crewflow-parity', api: 3400, front: 5400, pg: 15480 },
  devlike: { project: 'crewflow-e2e', api: 3300, front: 5300, pg: 15470 },
};
const requested = process.env.E2E_MODE ?? 'parity';
if (!(requested in MODES)) throw new Error(`e2e: E2E_MODE must be parity or devlike (got ${requested}).`);
export const MODE = requested as E2eMode;
/** HWS runtime routing: business rows in each workspace's own schema (devlike) or in `core`, scoped by organisation (parity). */
export const HWS_ON = MODE === 'devlike';
/** Workspace hosts (`<label>.localhost`), registry-backed origin trust and the cross-host login handoff. */
export const HOST_ROUTING = MODE === 'devlike';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const COMPOSE_FILE = join(REPO_ROOT, 'packages', 'rab-e2e-testing', 'system', 'docker-compose.e2e.yml');
export const PARITY_COMPOSE_FILE = join(REPO_ROOT, 'packages', 'rab-e2e-testing', 'system', 'docker-compose.parity.yml');
export const COMPOSE_FILES = HWS_ON ? [COMPOSE_FILE] : [COMPOSE_FILE, PARITY_COMPOSE_FILE];
export const COMPOSE_PROJECT = MODES[MODE].project;

export const API_HOST = '127.0.0.1';
export const API_PORT = Number(process.env.E2E_API_PORT ?? MODES[MODE].api);
export const FRONT_PORT = Number(process.env.E2E_FRONT_PORT ?? MODES[MODE].front);
export const PG_PORT = Number(process.env.E2E_PG_PORT ?? MODES[MODE].pg);
/** The API addressed directly (mobile clients, anonymous probes): no console proxy in between. */
export const API_DIRECT_HOST = `${API_HOST}:${API_PORT}`;
export const BASE_DOMAIN = `localhost:${FRONT_PORT}`;
export const DEFAULT_HOST = `127.0.0.1:${FRONT_PORT}`;
export const DEFAULT_ORIGIN = `http://${DEFAULT_HOST}`;
export const workspaceHost = (label: string) => `${label}.${BASE_DOMAIN}`;
export const workspaceOrigin = (label: string) => `http://${workspaceHost(label)}`;
/** Where a workspace's people work: their own workspace host with host routing, the one console host without it. */
export const managerHost = (label: string) => (HOST_ROUTING ? workspaceHost(label) : DEFAULT_HOST);
export const managerOrigin = (label: string) => (HOST_ROUTING ? workspaceOrigin(label) : DEFAULT_ORIGIN);

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

export const STATE_FILE = process.env.E2E_STATE_FILE ?? join(tmpdir(), `crewflow-e2e-w6-state-${MODE}.json`);
export const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? join(REPO_ROOT, 'docs', 'evidence', 'w6-e2e');

/** The first platform admin, created by the bootstrap-admin one-off (see docker-compose.e2e.yml). */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'w6.admin@crewflow-e2e.test';

/** One strong password for every synthetic account (synthetic stack only; never a real credential). */
export const SYNTHETIC_PASSWORD = process.env.E2E_SYNTHETIC_PASSWORD ?? 'W6-e2e-Synthetic-Pass-2026!';
export const RUN_ID = process.env.E2E_RUN_ID ?? new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
