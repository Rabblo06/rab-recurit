import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Upper bound for a person note (`user_note.body`), in characters (LAYER2_HARDENING_2026-10-25 F3). Enforced here by the
 * global ValidationPipe (400) AND again in `StaffService.addNote` (400), because jobs / other services call the service
 * directly and never pass the pipe. The column itself is unbounded `text`.
 */
export const NOTE_BODY_MAX_LENGTH = 2000;

export class AddNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(NOTE_BODY_MAX_LENGTH)
  body!: string;
}
