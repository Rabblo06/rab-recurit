import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RecentUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
