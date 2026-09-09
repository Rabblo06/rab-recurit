import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * `userIds` are StaffProfile/ManagerProfile ids (the same ids the Users
 * list already returns and the caller already had visible), never trusted
 * as authorization on their own — the service re-derives which of them the
 * caller is actually allowed to reach using the exact same ownership rule
 * `list()` already enforces, and silently drops anything outside it rather
 * than erroring (no existence disclosure for an id the caller can't see).
 * A 50-recipient cap keeps one request from becoming an accidental mass
 * send — bulk campaigns are out of scope for this feature.
 */
export class BulkEmailDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  userIds!: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}
