import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** `GET /rest/v1/ai/conversations` — keyset pagination (newest first): `limit` ≤ 50 and the opaque `cursor` of the previous page. */
export class ListAiConversationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/)
  cursor?: string;
}

/** `GET /rest/v1/ai/conversations/:id/stream?turnId=…` — which turn of the conversation to follow. */
export class StreamAiTurnDto {
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  turnId!: string;
}
