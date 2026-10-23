import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Wave 3 lane H (C3). Only the workspace name being typed; the email domain and organisation name are server-derived. */
export class SuggestSubdomainsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
