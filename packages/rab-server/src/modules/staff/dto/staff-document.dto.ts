import {
  REQUIRABLE_STAFF_DOCUMENT_TYPES,
  STAFF_DOCUMENT_TYPES,
} from '@rab/shared';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Multipart text fields of a document upload (the file is the `file` part). Only these three names are accepted:
 * forbidNonWhitelisted turns any other field — `organisationId`, `status`, `staffUserId`, `scanStatus` — into a 400.
 */
export class UploadStaffDocumentDto {
  @IsIn(STAFF_DOCUMENT_TYPES as string[])
  documentType!: string;

  @IsOptional()
  @Matches(DATE, { message: 'issuedOn must be a date (YYYY-MM-DD).' })
  issuedOn?: string;

  @IsOptional()
  @Matches(DATE, { message: 'expiresOn must be a date (YYYY-MM-DD).' })
  expiresOn?: string;
}

export class RejectStaffDocumentDto {
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class RevokeStaffDocumentDto {
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

/** The FULL list of required types for the organisation (replaces the previous configuration; [] = none required). */
export class SetStaffDocumentRequirementsDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(REQUIRABLE_STAFF_DOCUMENT_TYPES.length)
  @IsIn(REQUIRABLE_STAFF_DOCUMENT_TYPES as string[], { each: true })
  requiredTypes!: string[];
}
