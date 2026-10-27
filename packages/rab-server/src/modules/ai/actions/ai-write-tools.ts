import { AI_PROPOSAL_LIMITS, AI_WRITE_TOOL_NAMES, AiWriteToolName, PermissionFlag } from '@rab/shared';
import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { z } from 'zod';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { NOTE_BODY_MAX_LENGTH } from '../../identity/dto/add-note.dto';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { StaffService } from '../../staff/services/staff.service';
import { AiPrepared, AI_FORBIDDEN_ARGUMENT_KEYS, AiWriteTool, AiWriteToolFieldSpec } from './ai-write-tool.types';
import { snapshotHash, snapshotTimestamp } from './ai-snapshot';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Tool input bounds (security rule 7.2, PHASE5_TWENTY_PLAN §2.2). */
export const AI_SHIFT_TOOL_BOUNDS = { maxDurationHours: 24, horizonDays: 93, maxBreakMinutes: 240, maxNotesChars: 500 } as const;

const instant = z.iso.datetime({ offset: true });
const breakMinutes = z.number().int().min(0).max(AI_SHIFT_TOOL_BOUNDS.maxBreakMinutes);
const requiredCount = z.number().int().min(1).max(AI_PROPOSAL_LIMITS.maxRequiredCount);
const shiftNotes = z.string().max(AI_SHIFT_TOOL_BOUNDS.maxNotesChars);

/** A window the AI may propose: ends after it starts, at most 24 h long, starting between now and 93 days from now. */
function windowIssue(startsAt: Date, endsAt: Date, now = Date.now()): string | null {
  if (!(endsAt.getTime() > startsAt.getTime())) return 'endsAt must be after startsAt';
  if (endsAt.getTime() - startsAt.getTime() > AI_SHIFT_TOOL_BOUNDS.maxDurationHours * HOUR_MS) return `a shift may last at most ${AI_SHIFT_TOOL_BOUNDS.maxDurationHours} hours`;
  if (startsAt.getTime() < now || startsAt.getTime() > now + AI_SHIFT_TOOL_BOUNDS.horizonDays * DAY_MS) return `startsAt must be within the next ${AI_SHIFT_TOOL_BOUNDS.horizonDays} days`;
  return null;
}

export const createDraftShiftInput = z
  .strictObject({
    venueId: z.uuid(),
    jobRoleId: z.uuid(),
    startsAt: instant,
    endsAt: instant,
    breakMinutes: breakMinutes.optional(),
    requiredCount,
    notes: shiftNotes.optional(),
  })
  .superRefine((v, issue) => {
    const problem = windowIssue(new Date(v.startsAt), new Date(v.endsAt));
    if (problem) issue.addIssue({ code: 'custom', path: ['startsAt'], message: problem });
  });
export type CreateDraftShiftInput = z.infer<typeof createDraftShiftInput>;

const UPDATE_FIELDS = ['startsAt', 'endsAt', 'breakMinutes', 'requiredCount', 'notes'] as const;
export const updateDraftShiftInput = z
  .strictObject({
    shiftId: z.uuid(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    breakMinutes: breakMinutes.optional(),
    requiredCount: requiredCount.optional(),
    notes: shiftNotes.optional(),
  })
  .refine((v) => UPDATE_FIELDS.some((k) => v[k] !== undefined), { message: 'name at least one field to change', path: ['shiftId'] });
export type UpdateDraftShiftInput = z.infer<typeof updateDraftShiftInput>;

export const addStaffNoteInput = z.strictObject({
  staffProfileId: z.uuid(),
  body: z
    .string()
    .min(1)
    .max(Math.min(NOTE_BODY_MAX_LENGTH, AI_PROPOSAL_LIMITS.staffNoteMaxChars))
    .refine((b) => b.trim().length > 0, { message: 'the note cannot be blank' }),
});
export type AddStaffNoteInput = z.infer<typeof addStaffNoteInput>;

const SHIFT_FIELDS: readonly AiWriteToolFieldSpec[] = [
  { key: 'startsAt', label: 'Start', type: 'datetime' },
  { key: 'endsAt', label: 'End', type: 'datetime' },
  { key: 'breakMinutes', label: 'Break (minutes)', type: 'integer', min: 0, max: AI_SHIFT_TOOL_BOUNDS.maxBreakMinutes },
  { key: 'requiredCount', label: 'People needed', type: 'integer', min: 1, max: AI_PROPOSAL_LIMITS.maxRequiredCount },
  { key: 'notes', label: 'Shift notes (shown to staff)', type: 'multiline', maxLength: AI_SHIFT_TOOL_BOUNDS.maxNotesChars },
];

// ── Snapshots (read under RLS in the caller's workspace context; `lock` adds the row lock inside the executor) ────────
type Lock = '' | 'FOR SHARE' | 'FOR UPDATE';

async function venueSnapshot(m: EntityManager, id: string, lock: Lock) {
  const [row] = (await m.query(
    `SELECT id::text AS id, name, status, ${snapshotTimestamp('archived_at')} AS "archivedAt", ${snapshotTimestamp('updated_at')} AS "updatedAt"
       FROM venue WHERE id = $1 ${lock}`,
    [id],
  )) as Array<Record<string, unknown>>;
  return row ?? null;
}

async function jobRoleSnapshot(m: EntityManager, id: string, lock: Lock) {
  const [row] = (await m.query(
    `SELECT id::text AS id, name, created_by::text AS "createdBy", ${snapshotTimestamp('archived_at')} AS "archivedAt" FROM job_role WHERE id = $1 ${lock}`,
    [id],
  )) as Array<Record<string, unknown>>;
  return row ?? null;
}

async function shiftSnapshot(m: EntityManager, id: string, lock: Lock) {
  const [row] = (await m.query(
    `SELECT id::text AS id, status, venue_id::text AS "venueId", job_role_id::text AS "jobRoleId", created_by::text AS "createdBy",
            ${snapshotTimestamp('starts_at')} AS "startsAt", ${snapshotTimestamp('ends_at')} AS "endsAt", break_minutes AS "breakMinutes",
            required_count AS "requiredCount", notes, ${snapshotTimestamp('archived_at')} AS "archivedAt", ${snapshotTimestamp('updated_at')} AS "updatedAt"
       FROM shift WHERE id = $1 ${lock}`,
    [id],
  )) as Array<Record<string, unknown>>;
  return row ?? null;
}

async function staffProfileSnapshot(m: EntityManager, id: string, lock: Lock) {
  const [row] = (await m.query(
    `SELECT id::text AS id, created_by::text AS "createdBy", ${snapshotTimestamp('archived_at')} AS "archivedAt", ${snapshotTimestamp('updated_at')} AS "updatedAt"
       FROM staff_profile WHERE id = $1 ${lock}`,
    [id],
  )) as Array<Record<string, unknown>>;
  return row ?? null;
}

const createHashOf = async (m: EntityManager, input: CreateDraftShiftInput, lock: Lock) =>
  snapshotHash({ tool: 'create_draft_shift', venue: await venueSnapshot(m, input.venueId, lock), jobRole: await jobRoleSnapshot(m, input.jobRoleId, lock) });
const updateHashOf = async (m: EntityManager, input: UpdateDraftShiftInput, lock: Lock) =>
  snapshotHash({ tool: 'update_draft_shift', shift: await shiftSnapshot(m, input.shiftId, lock) });
const noteHashOf = async (m: EntityManager, input: AddStaffNoteInput, lock: Lock) =>
  snapshotHash({ tool: 'add_staff_note', staffProfile: await staffProfileSnapshot(m, input.staffProfileId, lock) });

// ── Server-written summaries (no model text; names are the organisation's own records) ─────────────────────────────
async function organisationTimezone(m: EntityManager): Promise<string> {
  const [row] = (await m.query(`SELECT o.timezone FROM core.organisation o WHERE o.id = core.current_org()`)) as Array<{ timezone: string | null }>;
  return row?.timezone || 'Europe/London';
}

function formatWindow(startsAt: Date, endsAt: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const sameDay = day.format(startsAt) === day.format(endsAt);
  return sameDay
    ? `${day.format(startsAt)}, ${time.format(startsAt)}–${time.format(endsAt)}`
    : `${day.format(startsAt)} ${time.format(startsAt)} – ${day.format(endsAt)} ${time.format(endsAt)}`;
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const clip = (s: string, max = 2000) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

async function namesFor(m: EntityManager, venueId: string, jobRoleId: string): Promise<{ venue: string; jobRole: string }> {
  const [row] = (await m.query(`SELECT (SELECT v.name FROM venue v WHERE v.id = $1) AS venue, (SELECT j.name FROM job_role j WHERE j.id = $2) AS "jobRole"`, [venueId, jobRoleId])) as Array<{
    venue: string | null;
    jobRole: string | null;
  }>;
  return { venue: row?.venue ?? 'the venue', jobRole: row?.jobRole ?? 'the job role' };
}

/**
 * The three Phase 5a write tools (PHASE5_TWENTY_PLAN §2.2; "send rota for review" does not exist — P5-D1). Each is
 * proposal-only: `prepare()` reads, `apply()` is the domain service's transaction-participating method, which re-checks
 * its own permission flag, ownership, state and archive rules (layer 2) under the approver's RLS context. Pay is never an
 * input (`touchesPay: false`); nothing deletes (`deletes: false`). Registered once; the constructor is the boot check.
 */
@Injectable()
export class AiWriteToolsService {
  private readonly tools: ReadonlyMap<AiWriteToolName, AiWriteTool>;

  constructor(
    private readonly scheduling: SchedulingService,
    private readonly staff: StaffService,
  ) {
    const all: AiWriteTool[] = [this.createDraftShift(), this.updateDraftShift(), this.addStaffNote()].map((t) => t as unknown as AiWriteTool);
    AiWriteToolsService.validate(all);
    this.tools = new Map(all.map((t) => [t.name, t]));
  }

  get(name: string): AiWriteTool | null {
    return this.tools.get(name as AiWriteToolName) ?? null;
  }

  names(): AiWriteToolName[] {
    return [...this.tools.keys()].sort();
  }

  /** Boot check: exactly the DB CHECK's three names; editable fields declared and never a target id or forbidden key. */
  static validate(tools: readonly AiWriteTool[]): void {
    const names = tools.map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...AI_WRITE_TOOL_NAMES].sort())) throw new Error(`AI write tools must be exactly ${AI_WRITE_TOOL_NAMES.join(', ')}`);
    for (const t of tools) {
      if (typeof (t as unknown as { run?: unknown }).run !== 'undefined') throw new Error(`AI write tool ${t.name} must not define a run function`);
      if (t.editableFields.length > AI_PROPOSAL_LIMITS.maxEditableFields) throw new Error(`AI write tool ${t.name}: too many editable fields`);
      const fieldKeys = new Set(t.fields.map((f) => f.key));
      for (const key of t.editableFields) {
        if (!fieldKeys.has(key)) throw new Error(`AI write tool ${t.name}: editable field ${key} has no field spec`);
        if (/Id$/.test(key) || AI_FORBIDDEN_ARGUMENT_KEYS.includes(key)) throw new Error(`AI write tool ${t.name}: ${key} may not be editable`);
      }
    }
  }

  private createDraftShift(): AiWriteTool<CreateDraftShiftInput> {
    const scheduling = this.scheduling;
    return {
      name: 'create_draft_shift',
      permission: PermissionFlag.SCHEDULE_CREATE,
      input: createDraftShiftInput,
      editableFields: ['startsAt', 'endsAt', 'breakMinutes', 'requiredCount', 'notes'],
      fields: SHIFT_FIELDS,
      async prepare(m: EntityManager, ctx: AuthContext, input: CreateDraftShiftInput): Promise<AiPrepared> {
        const { venue, jobRole } = await scheduling.resolveDraftTargetsTx(m, ctx, input.venueId, input.jobRoleId);
        const tz = await organisationTimezone(m);
        const brk = input.breakMinutes ? `, ${input.breakMinutes} min break` : '';
        const summary =
          `Create a DRAFT shift at ${venue.name} for ${people(input.requiredCount)} as ${jobRole.name}: ` +
          `${formatWindow(new Date(input.startsAt), new Date(input.endsAt), tz)}${brk}. ` +
          `Pay rate from the venue's settings; charge rate not set. Nothing is published or offered.`;
        return {
          summary: clip(summary),
          target: { type: 'venue', id: input.venueId },
          snapshotHash: await createHashOf(m, input, ''),
          affectedCount: input.requiredCount,
          touchesPay: false,
          deletes: false,
        };
      },
      lockAndHash: (m: EntityManager, _ctx: AuthContext, input: CreateDraftShiftInput) => createHashOf(m, input, 'FOR SHARE'),
      async apply(m: EntityManager, ctx: AuthContext, input: CreateDraftShiftInput) {
        // Explicit mapping: no pay field ever reaches the domain from a proposal (standard rate resolution, P5-D10).
        const shift = await scheduling.createDraftTx(m, ctx, {
          venueId: input.venueId,
          jobRoleId: input.jobRoleId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          breakMinutes: input.breakMinutes,
          requiredCount: input.requiredCount,
          notes: input.notes,
        });
        return { entityType: 'shift', entityId: shift.id };
      },
    };
  }

  private updateDraftShift(): AiWriteTool<UpdateDraftShiftInput> {
    const scheduling = this.scheduling;
    return {
      name: 'update_draft_shift',
      permission: PermissionFlag.SCHEDULE_CREATE,
      input: updateDraftShiftInput,
      editableFields: [...UPDATE_FIELDS],
      fields: SHIFT_FIELDS,
      async prepare(m: EntityManager, ctx: AuthContext, input: UpdateDraftShiftInput): Promise<AiPrepared> {
        const shift = await scheduling.getOwnDraftTx(m, ctx, input.shiftId);
        const startsAt = input.startsAt ? new Date(input.startsAt) : shift.startsAt;
        const endsAt = input.endsAt ? new Date(input.endsAt) : shift.endsAt;
        if (input.startsAt !== undefined || input.endsAt !== undefined) {
          const problem = windowIssue(startsAt, endsAt);
          if (problem) throw new BadRequestException(problem);
        } else if (!(endsAt.getTime() > startsAt.getTime())) {
          throw new BadRequestException('endsAt must be after startsAt');
        }
        const tz = await organisationTimezone(m);
        const names = await namesFor(m, shift.venueId, shift.jobRoleId);
        const changes: string[] = [];
        if (input.startsAt !== undefined || input.endsAt !== undefined) changes.push(`time → ${formatWindow(startsAt, endsAt, tz)}`);
        if (input.breakMinutes !== undefined) changes.push(`break → ${input.breakMinutes} min`);
        if (input.requiredCount !== undefined) changes.push(`people needed → ${input.requiredCount}`);
        if (input.notes !== undefined) changes.push('shift notes replaced (shown below)');
        const summary =
          `Update the DRAFT shift at ${names.venue} (${names.jobRole}), ${formatWindow(shift.startsAt, shift.endsAt, tz)}: ${changes.join('; ')}. ` +
          `It stays a draft; the pay rate is not changed.`;
        return {
          summary: clip(summary),
          target: { type: 'shift', id: input.shiftId },
          snapshotHash: await updateHashOf(m, input, ''),
          affectedCount: input.requiredCount ?? shift.requiredCount,
          touchesPay: false,
          deletes: false,
        };
      },
      lockAndHash: (m: EntityManager, _ctx: AuthContext, input: UpdateDraftShiftInput) => updateHashOf(m, input, 'FOR UPDATE'),
      // S6: the draft's current values ARE the snapshot's only while its hash is unchanged; seeing them needs the
      // write flag (checked by the caller as `permission`) AND schedule.view, plus ownership + DRAFT (getOwnDraftTx).
      previousValuesPermissions: [PermissionFlag.SCHEDULE_VIEW],
      async previousValues(m: EntityManager, ctx: AuthContext, input: UpdateDraftShiftInput, expectedHash: string) {
        let shift: Awaited<ReturnType<SchedulingService['getOwnDraftTx']>>;
        try {
          shift = await scheduling.getOwnDraftTx(m, ctx, input.shiftId);
        } catch (error) {
          if (error instanceof HttpException) return null; // not found / not owned / archived / no longer a draft
          throw error;
        }
        if ((await updateHashOf(m, input, '')) !== expectedHash) return null;
        return {
          startsAt: new Date(shift.startsAt).toISOString(),
          endsAt: new Date(shift.endsAt).toISOString(),
          breakMinutes: shift.breakMinutes ?? 0,
          requiredCount: shift.requiredCount,
          notes: shift.notes ?? null,
        };
      },
      async apply(m: EntityManager, ctx: AuthContext, input: UpdateDraftShiftInput) {
        const shift = await scheduling.updateDraftTx(m, ctx, input.shiftId, {
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          breakMinutes: input.breakMinutes,
          requiredCount: input.requiredCount,
          notes: input.notes,
        });
        return { entityType: 'shift', entityId: shift.id };
      },
    };
  }

  private addStaffNote(): AiWriteTool<AddStaffNoteInput> {
    const staff = this.staff;
    return {
      name: 'add_staff_note',
      permission: PermissionFlag.STAFF_EDIT,
      input: addStaffNoteInput,
      editableFields: ['body'],
      fields: [{ key: 'body', label: 'Note', type: 'multiline', maxLength: Math.min(NOTE_BODY_MAX_LENGTH, AI_PROPOSAL_LIMITS.staffNoteMaxChars) }],
      async prepare(m: EntityManager, ctx: AuthContext, input: AddStaffNoteInput): Promise<AiPrepared> {
        await staff.getOwnedProfileTx(m, ctx, input.staffProfileId);
        // The note text is never part of the summary: the card shows it as the quoted "Note" field (exactly what is saved).
        return {
          summary: `Add a note (${input.body.length} characters) to this staff member's profile. The text below is saved exactly as shown.`,
          target: { type: 'staff_profile', id: input.staffProfileId },
          snapshotHash: await noteHashOf(m, input, ''),
          affectedCount: 1,
          touchesPay: false,
          deletes: false,
        };
      },
      lockAndHash: (m: EntityManager, _ctx: AuthContext, input: AddStaffNoteInput) => noteHashOf(m, input, 'FOR SHARE'),
      async apply(m: EntityManager, ctx: AuthContext, input: AddStaffNoteInput) {
        const note = await staff.addNoteTx(m, ctx, input.staffProfileId, { body: input.body });
        return { entityType: 'user_note', entityId: note.id };
      },
    };
  }
}
