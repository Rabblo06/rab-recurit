import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Optional now — Mobile still sends it in the body (see
 * `CLIENT_PLATFORM_HEADER`); Web no longer does, since the refresh token
 * lives in the HttpOnly `rab_rt` cookie instead. `AuthController` resolves
 * whichever one is actually present.
 */
export class RefreshDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
