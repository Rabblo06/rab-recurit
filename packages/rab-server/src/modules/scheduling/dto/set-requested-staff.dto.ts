import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** Optimistic concurrency snapshot; IDs are validated against server scope. */
export class SetRequestedStaffDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  staffProfileIds!: string[];

  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  expectedStaffProfileIds!: string[];
}
