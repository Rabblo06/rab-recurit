import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/** Shared by Manager and Staff "Change Pending Email" actions — corrects a wrong email before activation. */
export class ChangePendingEmailDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;
}
