import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { CLIENT_UPLOADABLE_KINDS } from '../file-kinds';

/**
 * Deliberately tiny. There is no key, bucket, organisationId, workspaceId or
 * resource field: with `forbidNonWhitelisted` a body carrying any of them is a
 * 400, so a client cannot steer where its bytes land or whose file it is.
 */
export class CreateUploadIntentDto {
  @IsIn([...CLIENT_UPLOADABLE_KINDS])
  kind!: string;

  /** Display metadata only. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes!: number;

  @IsString()
  @MaxLength(100)
  contentType!: string;
}
