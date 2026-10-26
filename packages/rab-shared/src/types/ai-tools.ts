/**
 * AI contracts C0 — TOOL DISCOVERY (docs/ai/AI_CONTRACTS.md §2.3). Types and fixed names only: no behaviour.
 * Server-side definitions (`DefineToolOptions`, `forTurn`, `AiPermissionChecker`) are in
 * `packages/rab-server/src/modules/ai/contracts/tools.ts`.
 */
import type { PermissionFlagType } from '../constants/permission-flags';

/**
 * One union for every phase (resolution X-5):
 *   read  — Phase 3 domain reads; offered lazily through the catalogue + `execute_tool`.
 *   meta  — no domain permission, always offered to an eligible actor: `learn_tools`, `execute_tool` (Phase 3),
 *           `load_skills` (Phase 4). Gated by the AI access check itself.
 *   pause — `propose_action`, `ask_question`, `request_form` (Phase 5b). The registry REFUSES this kind until 5b merges.
 *   write — never offered to the model and never executed by it; reachable only as the `propose_action` enum and run only
 *           by the proposal executor after a person approves (rule 6.2). The registry REFUSES this kind until 5b merges.
 */
export type AiToolKind = 'read' | 'meta' | 'pause' | 'write';
export const AI_TOOL_KINDS: readonly AiToolKind[] = ['read', 'meta', 'pause', 'write'];

/** C1 (CD-7 / TW-D8) adds `update_plan`: a `meta` tool with no permission and no data access (informational checklist). */
export const AI_META_TOOL_NAMES = ['execute_tool', 'learn_tools', 'load_skills', 'update_plan'] as const;
export type AiMetaToolName = (typeof AI_META_TOOL_NAMES)[number];

export const AI_PAUSE_TOOL_NAMES = ['ask_question', 'propose_action', 'request_form'] as const;
export type AiPauseToolName = (typeof AI_PAUSE_TOOL_NAMES)[number];

/**
 * The SDK ToolSet the model sees (resolution X-4, C1 CD-7): a fixed, NAME-SORTED set of at most 7 tools — the 4 meta
 * tools plus, from 5b, the 3 pause tools — never a domain read or write tool directly. The injection suite's expected
 * list grows at 3w (`update_plan`), 4w (`load_skills`) and 5b (the pause tools). Byte-stable for a given permission set.
 */
export const AI_MAX_SDK_TOOLS = 7;

/** `update_plan` (CD-7): strict input `{steps}`; ≤ 6 updates per turn, each counted in `AI_TOOL_LIMITS.maxCallsPerTurn`. */
export const AI_PLAN_LIMITS = { maxSteps: 8, labelMaxChars: 100, maxUpdatesPerTurn: 6 } as const;
export type AiPlanStepStatus = 'pending' | 'in_progress' | 'done';
/** One checklist row. `label` is masked (emails / phones) before it is stored or streamed; plain text only. No "plan approved". */
export interface AiPlanStep {
  label: string;
  status: AiPlanStepStatus;
}

/**
 * The Phase 3 read set (12; the 5 Phase 1 names are kept for audit continuity). `get_holiday_overlap` is NOT built: no
 * leave data exists (P3-D8). A new read tool is a reviewed change to this list.
 */
export const AI_READ_TOOL_NAMES = [
  'compare_payroll_runs',
  'count_shifts',
  'find_shifts',
  'get_attendance_summary',
  'get_fill_rate',
  'get_offer_pipeline',
  'get_offer_status',
  'get_rota_coverage_gaps',
  'get_staff_availability',
  'get_timesheet_approval_queue',
  'get_venue_summary',
  'list_unfilled_shifts',
] as const;
export type AiReadToolName = (typeof AI_READ_TOOL_NAMES)[number];

/**
 * Outcome of one tool call as stored on the turn and shown in the chat (metadata only, never arguments or results).
 * Phase 1: ok | denied | invalid_input | error. Phase 3: unknown_tool (also for a known-but-not-permitted name — the same
 * answer, 404-not-403), tool_call_limit, output_too_large. Phase 4: skill_budget_exceeded. Phase 5b: proposal_created,
 * awaiting_input. The server-only audit distinguishes `not_offered` / `invalid_name`; those never reach a client.
 */
export type AiToolCallOutcome =
  | 'ok'
  | 'denied'
  | 'invalid_input'
  | 'error'
  | 'unknown_tool'
  | 'tool_call_limit'
  | 'output_too_large'
  | 'skill_budget_exceeded'
  | 'proposal_created'
  | 'awaiting_input';

/**
 * `ai_message.tool_calls[]`, target shape (Phase 1 `AiToolCallSummary` + fields). `name` is the INNER tool name for an
 * `execute_tool` call that was permitted, otherwise `unavailable_tool`; `learn_tools` is recorded under its own name.
 */
export interface AiToolCallSummaryV2 {
  name: string;
  outcome: AiToolCallOutcome;
  rows: number | null;
  /** Phase 2: UTF-8 code-unit offset into the turn's `content` where the call happened (step ordering). */
  offset?: number;
  kind?: AiToolKind;
  /** Phase 4: names only for a `load_skills` call (real or synthetic for tagged skills). Never content. */
  skills?: string[];
  /** C1 (CD-7): the latest `update_plan` steps (masked labels). */
  plan?: AiPlanStep[];
}

/**
 * C1 (CD-7): fixed server step labels for the chat ("Checking unfilled shifts…" → "Checked unfilled shifts (3)"). The
 * tool's ARGUMENTS are never shown (rule 11.2); `{rows}` comes from `AiToolCallSummaryV2.rows`; `{label}` (load_skills) is
 * the skill's label. Replaces the front's local `AI_TOOL_LABEL`. Agent 3 owns the wording (changes = an integration request).
 */
export interface AiToolStepLabel {
  running: string;
  done: string;
  doneWithRows: string;
}
export const AI_TOOL_STEP_LABELS: Readonly<Record<AiReadToolName | 'load_skills' | 'learn_tools' | 'update_plan' | 'ask_question' | 'request_form', AiToolStepLabel>> = {
  compare_payroll_runs: { running: 'Comparing payroll runs…', done: 'Compared payroll runs', doneWithRows: 'Compared payroll runs' },
  count_shifts: { running: 'Counting shifts…', done: 'Counted shifts', doneWithRows: 'Counted shifts ({rows} days)' },
  find_shifts: { running: 'Finding shifts…', done: 'Found shifts', doneWithRows: 'Found {rows} shifts' },
  get_attendance_summary: { running: 'Checking attendance…', done: 'Checked attendance', doneWithRows: 'Checked attendance' },
  get_fill_rate: { running: 'Checking the fill rate…', done: 'Checked the fill rate', doneWithRows: 'Checked the fill rate' },
  get_offer_pipeline: { running: 'Checking offers…', done: 'Checked offers', doneWithRows: 'Checked offers' },
  get_offer_status: { running: 'Checking offer status…', done: 'Checked offer status', doneWithRows: 'Checked offer status' },
  get_rota_coverage_gaps: { running: 'Checking coverage gaps…', done: 'Checked coverage gaps', doneWithRows: 'Found {rows} coverage gaps' },
  get_staff_availability: { running: 'Checking availability…', done: 'Checked availability', doneWithRows: 'Checked availability ({rows} days)' },
  get_timesheet_approval_queue: { running: 'Checking timesheets awaiting approval…', done: 'Checked timesheets awaiting approval', doneWithRows: 'Checked timesheets awaiting approval' },
  get_venue_summary: { running: 'Checking venues…', done: 'Checked venues', doneWithRows: 'Checked {rows} venues' },
  list_unfilled_shifts: { running: 'Checking unfilled shifts…', done: 'Checked unfilled shifts', doneWithRows: 'Found {rows} unfilled shifts' },
  learn_tools: { running: 'Looking up tools…', done: 'Looked up tools', doneWithRows: 'Looked up tools' },
  load_skills: { running: 'Loading a skill…', done: 'Loaded skill: {label}', doneWithRows: 'Loaded skill: {label}' },
  update_plan: { running: 'Updating the plan…', done: 'Updated the plan', doneWithRows: 'Updated the plan' },
  // Batch 3 (S7): the two pause tools that wait for the person. Fixed text, never the question or field labels.
  ask_question: { running: 'Preparing a question…', done: 'Asked you a question', doneWithRows: 'Asked you a question' },
  request_form: { running: 'Preparing a form…', done: 'Asked you to fill in a form', doneWithRows: 'Asked you to fill in a form' },
};

/** C1 (CD-9): one input parameter of a tool, derived by Agent 3 from the strict zod schema at registry build. */
export interface AiToolParameterView {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'uuid' | 'enum' | 'array';
  required: boolean;
  /** Fixed server text. */
  description: string;
  /** Human bounds, e.g. "at most 31 days", "1–25". */
  limits: string | null;
  enumValues?: string[];
}

/** Bounds every phase agrees on (P3-D4, P3-D5, P3-D11). Server constants in `ai.constants.ts` must equal these. */
export const AI_TOOL_LIMITS = {
  maxStringChars: 160,
  maxRows: 25,
  defaultOutputBytes: 8_192,
  maxOutputBytes: 16_384,
  maxCallsPerTurn: 12,
  maxLearnCallsPerTurn: 3,
  maxNamesPerLearn: 5,
  maxExecuteArgsBytes: 2_048,
  statementTimeoutMs: 5_000,
  /** One timer with Phase 2's heartbeat (resolution X-10): fingerprint every tick, full check on change + every 15 s. */
  accessRecheckMs: 2_000,
  fullRecheckMs: 15_000,
  /** Consecutive fingerprint failures that abort the turn with AI_SERVICE_UNAVAILABLE (fail closed). */
  maxRecheckFailures: 3,
  maxDescriptionChars: 400,
  maxSuggestions: 3,
} as const;

/** One row of Settings → AI → Tools (`GET /rest/v1/ai/settings/tools`, Phase 8). Fixed server text and flags only. */
export interface AiToolCatalogueEntryView {
  name: string;
  /** Fixed, present-tense-free label ("Unfilled shifts"). */
  label: string;
  summary: string;
  kind: AiToolKind;
  /** null for meta and pause tools. */
  permission: PermissionFlagType | null;
  permissionLabel: string | null;
  /** The caller holds `permission` right now (server-resolved, never from the JWT). */
  held: boolean;
  maxRows: number | null;
  maxBytes: number | null;
  /** Write tools: always true (proposal-only). */
  requiresApproval: boolean;
  /** C1 (CD-9): present once Phase 3 merges. Never schema internals beyond these fields. */
  parameters?: AiToolParameterView[];
  /**
   * Batch 3 (R-U2): the tool's OUTPUT allowlist — the only field names it can ever return to the model (every other key
   * is dropped by the output guard), the same list `learn_tools` shows. Names only, never values. Empty for meta / pause.
   */
  outputFields?: string[];
}

export interface AiToolCatalogueView {
  tools: AiToolCatalogueEntryView[];
}
