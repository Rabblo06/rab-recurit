import { AI_PROPOSAL_LIMITS, AiProposalApproveRequest, AiProposalRejectRequest } from '@rab/shared';
import { IsObject, IsOptional, IsString, Length } from 'class-validator';

/**
 * `POST /rest/v1/ai/proposals/:id/approve`. `forbidNonWhitelisted` (main.ts) turns `organisationId`, `status`, `tool`,
 * `arguments` or any other undeclared key into a 400. `edits` is checked by the service: every key must be one of the
 * proposal's `editable_fields` (the fields the assistant proposed), every value a string, number or null, and the merged
 * arguments must pass the tool's strict schema again.
 */
export class ApproveAiProposalDto implements AiProposalApproveRequest {
  @IsOptional()
  @IsObject()
  edits?: Record<string, string | number | null>;

  @IsOptional()
  @IsString()
  @Length(AI_PROPOSAL_LIMITS.reasonMinChars, AI_PROPOSAL_LIMITS.reasonMaxChars)
  reason?: string;
}

/** `POST /rest/v1/ai/proposals/:id/reject`. A reason is required; nothing changes except the proposal's status. */
export class RejectAiProposalDto implements AiProposalRejectRequest {
  @IsString()
  @Length(AI_PROPOSAL_LIMITS.reasonMinChars, AI_PROPOSAL_LIMITS.reasonMaxChars)
  reason!: string;
}
