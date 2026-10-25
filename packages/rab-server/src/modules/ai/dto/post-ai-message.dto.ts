import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * `POST /rest/v1/ai/conversations/:id/messages`. Only the question text and an optional client idempotency key; a body
 * carrying anything else (organisationId, workspaceId, userId, role, status, tools, model, system…) is a 400 through
 * the global `forbidNonWhitelisted` pipe. The hard cap here is absolute; the configured AI_MAX_INPUT_CHARS (≤ 8000) is
 * enforced by the service with a specific code.
 */
export class PostAiMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  content!: string;

  /** Same value on a retried POST ⇒ the same turn is returned (`replayed: true`), never a second question. */
  @IsOptional()
  @IsUUID('4')
  clientRequestId?: string;
}
