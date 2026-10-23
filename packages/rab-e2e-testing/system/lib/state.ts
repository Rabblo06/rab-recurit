import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { STATE_FILE } from './env';

/** Cross-spec state for the serial system run (ids and synthetic emails only — never a password or token). */
export interface Tenant {
  orgId?: string;
  orgName?: string;
  ceoEmail?: string;
  imEmail?: string;
  label?: string;
  workspaceId?: string;
  schema?: string;
  venueId?: string;
  geoVenueId?: string;
  jobRoleId?: string;
  staffEmail?: string;
  staffProfileId?: string;
  staffUserId?: string;
  shiftId?: string;
  offerId?: string;
  attendanceId?: string;
  payrollRecordId?: string;
  payrollRunId?: string;
  archivedVenueId?: string;
}

export interface SystemState {
  runId?: string;
  adminEmail?: string;
  A: Tenant;
  B: Tenant;
  notes: Record<string, unknown>;
}

export function loadState(): SystemState {
  if (!existsSync(STATE_FILE)) return { A: {}, B: {}, notes: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SystemState;
}

export function saveState(s: SystemState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function updateState(fn: (s: SystemState) => void): SystemState {
  const s = loadState();
  fn(s);
  saveState(s);
  return s;
}
