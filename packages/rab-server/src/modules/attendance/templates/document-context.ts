import { EntityManager } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { DocumentShiftInfo } from './adolphus-document';

/**
 * A stable, human-readable shift reference derived from the shift's own id and start date (there is no separate
 * reference column): `SHIFT-20261016-9A3B0C`. Deterministic, so the same shift always prints the same reference.
 */
export function shiftReference(shift: Pick<Shift, 'id' | 'startsAt'>, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shift.startsAt);
  return `SHIFT-${parts.replace(/-/g, '')}-${shift.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

function contactField(contact: unknown, key: string): string | null {
  if (!contact || typeof contact !== 'object') return null;
  const v = (contact as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Header data for the Adolphus documents, read inside the caller's (worker) tenant transaction from authoritative rows:
 * venue (name, address, optional `contact.name` / `contact.phone`), job role, workspace name, the organisation's
 * timezone (default Europe/London) and the shift's notes. Nothing is invented: an absent optional field stays null and
 * the template omits that line.
 */
export async function loadDocumentShiftInfo(manager: EntityManager, shift: Shift, generatedAt: Date): Promise<DocumentShiftInfo> {
  const [venue] = await manager.query(`SELECT name, address, contact FROM venue WHERE id = $1`, [shift.venueId]);
  const [role] = await manager.query(`SELECT name FROM job_role WHERE id = $1`, [shift.jobRoleId]);
  const [org] = await manager.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [shift.organisationId]);
  const [workspace] = shift.workspaceId ? await manager.query(`SELECT name FROM core.manager_workspace WHERE id = $1`, [shift.workspaceId]) : [];
  const timezone = (org?.timezone as string | undefined) || 'Europe/London';
  return {
    venueName: venue?.name ?? 'Venue',
    venueAddress: shift.address ?? (typeof venue?.address === 'string' ? venue.address : null),
    roleName: role?.name ?? 'Role',
    department: null,
    startsAt: shift.startsAt.toISOString(),
    endsAt: shift.endsAt.toISOString(),
    contactName: contactField(venue?.contact, 'name'),
    contactPhone: contactField(venue?.contact, 'phone'),
    shiftReference: shiftReference(shift, timezone),
    workspaceName: workspace?.name ?? null,
    notes: shift.notes ?? null,
    timezone,
    generatedAt: generatedAt.toISOString(),
  };
}
