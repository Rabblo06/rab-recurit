import { AiInputAnswerRequest } from '@rab/shared';
import { IsDefined, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

/** Shape bounds checked at the edge (the service re-checks everything against the stored question / form spec). */
const MAX_TEXT = 2_000;
const MAX_FIELDS = 8;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * Batch 3 S7: `answer` is a string (a question) or a flat object of ≤ 8 camelCase keys whose values are strings (≤ 2,000),
 * finite numbers or null (a form). Anything else — arrays, nested objects, booleans, oversize text — is a 400 here,
 * before the service validates the answer against the stored spec (exact options, field types, required fields).
 */
@ValidatorConstraint({ name: 'aiInputAnswerShape', async: false })
export class AiInputAnswerShape implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value === 'string') return value.length <= MAX_TEXT;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_FIELDS) return false;
    return entries.every(
      ([key, v]) => FIELD_KEY.test(key) && (v === null || (typeof v === 'string' && v.length <= MAX_TEXT) || (typeof v === 'number' && Number.isFinite(v))),
    );
  }

  defaultMessage(): string {
    return 'answer must be text, or a flat object of field values (text, number or null)';
  }
}

/**
 * `POST /rest/v1/ai/conversations/:id/inputs/:requestId/answer`. `forbidNonWhitelisted` (main.ts) turns `organisationId`,
 * `state`, `requestId` or any other undeclared key into a 400. The answer is user input: it is bounded here, validated
 * against the question / form by the service, stored on its own request row, and reaches the model only as wrapped,
 * untrusted data in a continuation turn. It never changes a record.
 */
export class AnswerAiInputDto implements AiInputAnswerRequest {
  @IsDefined()
  @Validate(AiInputAnswerShape)
  answer!: string | Record<string, string | number | null>;
}
