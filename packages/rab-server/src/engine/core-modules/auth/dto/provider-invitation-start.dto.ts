import { IsString, Length } from 'class-validator';

/** Body of `POST /rest/v1/auth/{google|microsoft}/invitation` (a top-level form POST from the invitation page). */
export class ProviderInvitationStartDto {
  @IsString()
  @Length(20, 128)
  token!: string;
}
