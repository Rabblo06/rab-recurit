import { IsIn, IsOptional } from 'class-validator';
import { APPLICATION_TARGETS, ApplicationTarget } from '../application-access';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @IsOptional()
  @IsIn(APPLICATION_TARGETS)
  applicationTarget?: ApplicationTarget;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;
}
