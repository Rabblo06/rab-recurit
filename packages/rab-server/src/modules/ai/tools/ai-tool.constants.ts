import { AI_TOOL_LIMITS } from '@rab/shared';

/**
 * AI Phase 3 tool-layer bounds (docs/ai/PHASE3_TWENTY_PLAN.md §2.4–§2.6, P3-D4 / D5 / D11). Each value is taken from the
 * C0 contract `AI_TOOL_LIMITS` (rab-shared `types/ai-tools.ts`) so the server and every client agree; `ai-tool-limits.spec`
 * pins the numbers. Kept in this file (not `constants/ai.constants.ts`, PL-13) so the tool layer owns its own limits.
 */
/** Strings are cut to this many characters by the output guard (unchanged from Phase 1). */
export const AI_TOOL_MAX_STRING_CHARS = AI_TOOL_LIMITS.maxStringChars;
/** Default row bound of a tool's arrays (a tool may declare fewer; `count_shifts` byDay is the one documented exception). */
export const AI_TOOL_DEFAULT_MAX_ROWS = AI_TOOL_LIMITS.maxRows;
/** Documented row-bound exceptions (PHASE3_TWENTY_PLAN §4): `count_shifts` lists up to 62 local days. */
export const AI_TOOL_MAX_ROWS_EXCEPTIONS: Readonly<Record<string, number>> = Object.freeze({ count_shifts: 62 });
/** UTF-8 bytes of one wrapped tool result: default and hard maximum. */
export const AI_TOOL_DEFAULT_OUTPUT_BYTES = AI_TOOL_LIMITS.defaultOutputBytes;
export const AI_TOOL_MAX_OUTPUT_BYTES = AI_TOOL_LIMITS.maxOutputBytes;
/** Per-turn caps: tool executions (direct or through `execute_tool`), `learn_tools` calls, names per learn, args size. */
export const AI_MAX_TOOL_CALLS_PER_TURN = AI_TOOL_LIMITS.maxCallsPerTurn;
export const AI_MAX_LEARN_CALLS_PER_TURN = AI_TOOL_LIMITS.maxLearnCallsPerTurn;
export const AI_LEARN_MAX_NAMES = AI_TOOL_LIMITS.maxNamesPerLearn;
export const AI_EXECUTE_MAX_ARGS_BYTES = AI_TOOL_LIMITS.maxExecuteArgsBytes;
/** Per-statement bound of every assistant read (`SET LOCAL statement_timeout`, engine/utils/assistant-read.util.ts). */
export const AI_TOOL_STATEMENT_TIMEOUT_MS = AI_TOOL_LIMITS.statementTimeoutMs;
/** The 2 s access fingerprint (on Phase 2's heartbeat at 3w), the 15 s full re-check, and the fail-closed error budget. */
export const AI_ACCESS_RECHECK_MS = AI_TOOL_LIMITS.accessRecheckMs;
export const AI_ACCESS_FULL_RECHECK_MS = AI_TOOL_LIMITS.fullRecheckMs;
export const AI_ACCESS_MAX_RECHECK_FAILURES = AI_TOOL_LIMITS.maxRecheckFailures;
/** Description and catalogue summary bound (fixed server text). */
export const AI_TOOL_MAX_DESCRIPTION_CHARS = AI_TOOL_LIMITS.maxDescriptionChars;
export const AI_TOOL_MAX_SUGGESTIONS = AI_TOOL_LIMITS.maxSuggestions;
/** The name every non-permitted inner tool is recorded and streamed under (never the model's string). */
export const AI_UNAVAILABLE_TOOL_NAME = 'unavailable_tool';
/** Argument keys no tool input may declare (rule 7.1 / CLAUDE.md: tenant, identity, raw status and SQL never come from the model). */
export const AI_TOOL_FORBIDDEN_INPUT_KEYS: readonly string[] = Object.freeze(['organisationId', 'workspaceId', 'staffId', 'userId', 'status', 'sql']);
/**
 * Fixed short labels of the read tools (Settings -> AI -> Tools, `GET /ai/capabilities`). Server text only; Agent 9 may move
 * them next to `AI_TOOL_STEP_LABELS` in rab-shared at merge (integration request in REQUEST.md).
 */
export const AI_READ_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  compare_payroll_runs: 'Payroll run totals',
  count_shifts: 'Shift counts',
  find_shifts: 'Find shifts',
  get_attendance_summary: 'Attendance totals',
  get_fill_rate: 'Fill rate',
  get_offer_pipeline: 'Offer pipeline',
  get_offer_status: 'Offer status',
  get_rota_coverage_gaps: 'Coverage gaps',
  get_staff_availability: 'Staff availability (counts)',
  get_timesheet_approval_queue: 'Timesheets awaiting approval',
  get_venue_summary: 'Venue summary',
  list_unfilled_shifts: 'Unfilled shifts',
});
