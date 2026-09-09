import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Rejects a future date of birth and unrealistic ages (under 14 / over
 * 100) — `@IsDateString()` alone only checks the string is a valid date,
 * not that it's a plausible birth date. Shared by Create/Update Staff DTOs
 * so the bound can't drift between the two.
 */
export function IsRealisticBirthDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRealisticBirthDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return false;
          const ageYears = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
          return ageYears >= 14 && ageYears <= 100;
        },
        defaultMessage(): string {
          return 'dateOfBirth must reflect an age between 14 and 100, and cannot be in the future.';
        },
      },
    });
  };
}
