import { IsIn } from 'class-validator';

export const AI_USAGE_PERIODS = ['today', 'month'] as const;
export type AiUsagePeriod = (typeof AI_USAGE_PERIODS)[number];

/**
 * `GET /rest/v1/ai/settings/usage?period=today|month` (Phase 7). `period` is the ONLY accepted parameter: the organisation
 * and the user come from the verified session, so a query carrying `organisationId` (or anything else) is a 400 through
 * the global `forbidNonWhitelisted` pipe — never a hint and never a silent override.
 */
export class AiUsageQueryDto {
  @IsIn(AI_USAGE_PERIODS)
  period!: AiUsagePeriod;
}
