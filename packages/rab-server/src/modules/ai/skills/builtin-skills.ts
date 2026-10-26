import { AI_BUILTIN_SKILL_NAMES, AiBuiltinSkillName } from '@rab/shared';

/**
 * The built-in skills (docs/ai/PHASE4_TWENTY_PLAN.md §2.2, P4-D1/D2/D11 as amended by resolution XD-4 / X-8).
 *
 * Built-in text lives HERE, in reviewed code — never in the database (conflict C1). `core.ai_skill` only holds an on/off
 * row for a built-in an organisation has switched (no row = active, P4-D2); its CHECK lists exactly
 * AI_BUILTIN_SKILL_NAMES. `holiday-planning` is dropped until a leave feature exists. `rota-building` and
 * `timesheet-review` are written against the REAL Phase 3 read tools only (coverage gaps, unfilled shifts, shift and
 * approval-queue COUNTS): there is no "rota" object, no demand model and no "anomaly" report, and drafts are offered only
 * through `propose_action` when that tool exists (Phase 5).
 *
 * Every text: "Use when", numbered steps, "Rules", and the fixed last line AI_BUILTIN_SKILL_CLOSING. Every text passes the
 * same write-time content rules as a custom skill and every snake_case tool name it mentions is in AI_READ_TOOL_NAMES or
 * is followed by "(if available)" (unit test T4-U2). A change to any text bumps AI_BUILTIN_SKILLS_VERSION, which is part
 * of the system-prompt version from 4w.
 */
export const AI_BUILTIN_SKILLS_VERSION = '2026-10-25.1';

/** The fixed last line of every built-in (P4 §2.2). */
export const AI_BUILTIN_SKILL_CLOSING = 'This skill gives no extra permissions; use only the tools you were given.';

export interface AiBuiltinSkill {
  readonly name: AiBuiltinSkillName;
  readonly label: string;
  /** The catalogue line the prompt shows (≤ 300). */
  readonly description: string;
  /** Markdown (≤ 20,000), loaded only through `load_skills`. */
  readonly content: string;
}

const text = (...lines: string[]): string => [...lines, '', AI_BUILTIN_SKILL_CLOSING].join('\n');

const DEFINITIONS: Record<AiBuiltinSkillName, Omit<AiBuiltinSkill, 'name'>> = {
  'coverage-report': {
    label: 'Coverage report',
    description: 'Summarise fill rate and coverage gaps for a period.',
    content: text(
      '# Coverage report',
      '',
      'Use when a manager asks how well shifts are covered for a period, for example "how is cover looking next week?".',
      '',
      '## Steps',
      '1. Confirm the period and use explicit dates. Keep within the range each tool accepts; if the period is longer, say so and suggest a shorter one.',
      '2. Read the fill rate for the period with `get_fill_rate`.',
      '3. Read the gaps by day, venue and job role with `get_rota_coverage_gaps`.',
      '4. Read the offers still waiting for a reply with `get_offer_pipeline`.',
      '5. Answer with a short table of the gaps (day, venue, job role, seats vacant) and a summary of at most three lines that names the period.',
      '',
      '## Rules',
      '- Use only the numbers the tools return. Never estimate, extrapolate or fill in a missing figure.',
      '- If a tool is not available to you, leave that part out and say that it is not available.',
      '- Do not name, rank or compare individual staff.',
    ),
  },
  'crewflow-help': {
    label: 'Crewflow help',
    description: 'Answer "how do I" questions about the Crewflow web console screens.',
    content: text(
      '# Crewflow help',
      '',
      'Use when a manager asks how to do something in the Crewflow web console, for example "where do I approve timesheets?".',
      '',
      '## Steps',
      '1. Work out which task the manager means. If it is unclear, ask one short question.',
      '2. Answer in one to three short steps that name the screen in the left-hand menu: Dashboard, Users, Shifts, Calendar, Offers, Venue Offers, Venues, Payroll, Audit Log, Settings, Help Center or Support.',
      '3. If the answer depends on what the manager is allowed to do, say that the option appears only with the right permission and that they should ask their organisation\'s CEO.',
      '',
      '## Rules',
      '- Never invent a screen, button or setting. If you are not sure where something is, say that you do not know and suggest the Help Center.',
      '- Explain only. You cannot open screens, change settings or do the task for the manager.',
    ),
  },
  'rota-building': {
    label: 'Rota building',
    description: "Plan a week's shifts for a venue from the shifts that exist and their coverage gaps; a manager creates and publishes.",
    content: text(
      '# Rota building',
      '',
      'Use when a manager asks to build, draft or check the shifts for a venue for a week. Crewflow has no separate rota object: a rota here means the shifts of that venue and week.',
      '',
      '## Steps',
      '1. Confirm the venue, the week (explicit dates) and the job roles.',
      '2. Read the shifts that already exist with `find_shifts` and their totals by day with `count_shifts`.',
      '3. Read the seats still vacant with `get_rota_coverage_gaps` and the unfilled shifts with `list_unfilled_shifts`.',
      '4. If it helps, read how many staff declared themselves available on each day with `get_staff_availability`. These are counts only.',
      '5. List what the manager may still need as a table: day, start and end time, job role, seats needed. Base it only on the shifts and gaps the tools returned and on what the manager told you; never on a forecast.',
      '6. Offer drafts only through `propose_action` (if available), one shift per proposal. Without that tool, list the shifts for the manager to create in Shifts.',
      '7. Say that a manager reviews, creates and publishes the shifts.',
      '',
      '## Rules',
      '- Never publish a shift, never choose or assign staff and never set pay or rates.',
      '- Never invent demand. If the tools do not show it, ask the manager.',
    ),
  },
  'shift-filling': {
    label: 'Shift filling',
    description: 'Help a manager see which open seats need filling; a person decides who gets work.',
    content: text(
      '# Shift filling',
      '',
      'Use when a manager asks which shifts still need people or how to fill open seats.',
      '',
      '## Steps',
      '1. Confirm the period and, if the manager names one, the venue.',
      '2. Read the unfilled shifts with `list_unfilled_shifts`.',
      '3. Read the offers already sent and waiting for a reply with `get_offer_pipeline`.',
      '4. If it helps, read how many staff declared themselves available on those days with `get_staff_availability`. These are counts only.',
      '5. Present the options neutrally, as counts per shift or per day, for example "3 seats open, 2 offers waiting, 5 staff declared available".',
      '6. Say that the manager sends offers from Shifts or Offers.',
      '',
      '## Rules',
      '- Never recommend, rank or score a named person for work or pay (UK GDPR Article 22). A person decides.',
      '- Never send, withdraw or confirm an offer.',
    ),
  },
  'timesheet-review': {
    label: 'Timesheet review',
    description: 'Summarise timesheets awaiting approval, as counts; a manager reviews and approves.',
    content: text(
      '# Timesheet review',
      '',
      'Use when a manager asks what timesheets or hours still need checking or approving.',
      '',
      '## Steps',
      '1. Confirm the period, if the manager gives one.',
      '2. Read the approval queue with `get_timesheet_approval_queue`: records awaiting approval, rejected records, the oldest shift date still awaiting approval and, where the tool returns them, attendance records under review or disputed and shift reports not yet finalised.',
      '3. Read the attendance totals for the same period with `get_attendance_summary` if the manager wants them.',
      '4. Answer with the counts and the oldest date, and name the period. If a count comes back empty, say it is not available to you.',
      '5. Say that a manager reviews and approves in Payroll.',
      '',
      '## Rules',
      '- Report only the counts and dates the tools return. Do not describe problems the tools do not report.',
      '- Never show individual pay figures and never approve, reject or change a timesheet.',
    ),
  },
  'venue-onboarding': {
    label: 'Venue onboarding',
    description: 'Explain the steps to set up a new venue in Crewflow.',
    content: text(
      '# Venue onboarding',
      '',
      'Use when a manager asks how to set up a new venue.',
      '',
      '## Steps',
      '1. Venue details: in Venues, choose Create venue and enter the name, client, type, address, location and geofence, and the default break.',
      '2. Role pay rates: after the venue is saved, open it again to add a pay rate for each job role. A manager enters the rates; you never suggest an amount.',
      '3. Venue managers: invite or assign them from Users.',
      '4. First shifts: create them in Shifts for the new venue, then publish them when they are ready.',
      '5. If a step is missing for the manager, say that it needs the right permission and that they should ask their organisation\'s CEO.',
      '',
      '## Rules',
      '- This is help text only. You cannot create or change venues, rates, people or shifts.',
      '- Never invent a field or a screen.',
    ),
  },
};

/** The built-ins in AI_BUILTIN_SKILL_NAMES order. Frozen: a built-in can only be switched on or off, never edited. */
export const AI_BUILTIN_SKILLS: readonly AiBuiltinSkill[] = Object.freeze(
  AI_BUILTIN_SKILL_NAMES.map((name) => Object.freeze({ name, ...DEFINITIONS[name] })),
);

export function isBuiltinSkillName(name: unknown): name is AiBuiltinSkillName {
  return typeof name === 'string' && (AI_BUILTIN_SKILL_NAMES as readonly string[]).includes(name);
}

export function builtinSkill(name: string): AiBuiltinSkill | null {
  return AI_BUILTIN_SKILLS.find((s) => s.name === name) ?? null;
}
