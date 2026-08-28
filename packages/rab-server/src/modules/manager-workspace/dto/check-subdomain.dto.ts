import { IsString, MaxLength, MinLength } from 'class-validator';

export class CheckSubdomainDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  candidate!: string;
}
