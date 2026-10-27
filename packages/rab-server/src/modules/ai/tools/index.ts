import type { FactoryProvider, Type } from '@nestjs/common';

import type { AiDefinedReadTool } from '../contracts/tools';
import { ComparePayrollRunsTool } from './read/compare-payroll-runs.tool';
import { CountShiftsTool } from './read/count-shifts.tool';
import { FindShiftsTool } from './read/find-shifts.tool';
import { GetAttendanceSummaryTool } from './read/get-attendance-summary.tool';
import { GetFillRateTool } from './read/get-fill-rate.tool';
import { GetOfferPipelineTool } from './read/get-offer-pipeline.tool';
import { GetOfferStatusTool } from './read/get-offer-status.tool';
import { GetRotaCoverageGapsTool } from './read/get-rota-coverage-gaps.tool';
import { GetStaffAvailabilityTool } from './read/get-staff-availability.tool';
import { GetTimesheetApprovalQueueTool } from './read/get-timesheet-approval-queue.tool';
import { GetVenueSummaryTool } from './read/get-venue-summary.tool';
import { ListUnfilledShiftsTool } from './read/list-unfilled-shifts.tool';

/**
 * THE reviewed list of AI read tools (AI Phase 3, docs/ai/PHASE3_TWENTY_PLAN.md §2.1). The registry receives exactly these
 * instances through the `AI_TOOL_CLASSES` token — there is NO DiscoveryService scan, so a stray `@DefineTool()` class can
 * never register itself. Adding a tool is a reviewed change here AND to `AI_READ_TOOL_NAMES` (rab-shared); a static test
 * (`ai-tool-registry.spec.ts`) asserts this array, the files under `tools/read/` and that list are the same set.
 * `get_holiday_overlap` is NOT built: no leave data exists (P3-D8).
 */
export const AI_READ_TOOLS: readonly Type<AiDefinedReadTool>[] = Object.freeze([
  ComparePayrollRunsTool,
  CountShiftsTool,
  FindShiftsTool,
  GetAttendanceSummaryTool,
  GetFillRateTool,
  GetOfferPipelineTool,
  GetOfferStatusTool,
  GetRotaCoverageGapsTool,
  GetStaffAvailabilityTool,
  GetTimesheetApprovalQueueTool,
  GetVenueSummaryTool,
  ListUnfilledShiftsTool,
]);

/** Injection token: the instances of `AI_READ_TOOLS`, in that order. */
export const AI_TOOL_CLASSES = Symbol('AI_TOOL_CLASSES');

/** The providers `AiCoreModule` registers (every tool class + the one collecting factory). */
export const AI_TOOL_PROVIDERS: ReadonlyArray<Type<AiDefinedReadTool> | FactoryProvider> = Object.freeze([
  ...AI_READ_TOOLS,
  { provide: AI_TOOL_CLASSES, useFactory: (...tools: AiDefinedReadTool[]) => Object.freeze(tools), inject: [...AI_READ_TOOLS] },
]);
