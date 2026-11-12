import { CONFIRMATION_DEADLINE_MESSAGES } from '@rab/shared';
import {
  confirmByLabel,
  confirmationDeadlineMessage,
  formatApprovalDeadline,
  isConfirmationDeadlineError,
  isWithdrawnAtDeadline,
  mayDecideAcceptedOffer,
} from './offerConfirmation';

describe('mayDecideAcceptedOffer — only the server fields decide, never a device clock', () => {
  const open = { status: 'staff_accepted', approvalDeadlineAt: '2030-01-01T17:30:00Z', awaitingManagerConfirmation: true, closedReason: null, canConfirm: true };
  it('allows a staff_accepted offer the server says is awaiting this manager', () => {
    expect(mayDecideAcceptedOffer(open)).toBe(true);
  });
  it.each([
    ['canConfirm false', { canConfirm: false }],
    ['no longer awaiting', { awaitingManagerConfirmation: false }],
    ['withdrawn at the deadline', { closedReason: 'confirmation_deadline_passed' }],
    ['shift cancelled', { closedReason: 'shift_cancelled' }],
    ['not staff_accepted', { status: 'manager_confirmed' }],
  ])('refuses when %s', (_label, over) => {
    expect(mayDecideAcceptedOffer({ ...open, ...over })).toBe(false);
  });
  it('an older API without the fields keeps today\'s rule', () => {
    expect(mayDecideAcceptedOffer({ status: 'staff_accepted' })).toBe(true);
    expect(mayDecideAcceptedOffer({ status: 'pending' })).toBe(false);
  });
  it('ignores the device clock: a deadline in the past with awaiting=true is still the server\'s call', () => {
    expect(mayDecideAcceptedOffer({ ...open, approvalDeadlineAt: '2000-01-01T00:00:00Z' })).toBe(true);
  });
});

describe('deadline display', () => {
  it('formats the server instant in local time with a time zone', () => {
    const text = formatApprovalDeadline('2030-01-01T17:30:00Z')!;
    expect(text).toMatch(/\d{2}:\d{2}/);
    expect(text).toMatch(/(GMT|UTC|BST|[A-Z]{2,5}|[+-]\d)/);
    expect(confirmByLabel('2030-01-01T17:30:00Z')).toBe(`Confirm by ${text}`);
  });
  it('is null (never invented) when the deadline is missing or invalid', () => {
    expect(formatApprovalDeadline(undefined)).toBeNull();
    expect(formatApprovalDeadline(null)).toBeNull();
    expect(formatApprovalDeadline('not a date')).toBeNull();
    expect(confirmByLabel(undefined)).toBeNull();
  });
  it('isWithdrawnAtDeadline reads only closedReason', () => {
    expect(isWithdrawnAtDeadline({ closedReason: 'confirmation_deadline_passed' })).toBe(true);
    expect(isWithdrawnAtDeadline({ closedReason: 'shift_cancelled' })).toBe(false);
    expect(isWithdrawnAtDeadline({})).toBe(false);
  });
});

describe('409 CONFIRMATION_DEADLINE_PASSED', () => {
  const refusal = (message: unknown) => ({ response: { status: 409, data: { statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message } } });
  it('is recognised by its code only', () => {
    expect(isConfirmationDeadlineError(refusal('x'))).toBe(true);
    expect(isConfirmationDeadlineError({ response: { status: 409, data: { code: 'STAFF_AVAILABILITY_CONFLICT' } } })).toBe(false);
    expect(isConfirmationDeadlineError(new Error('boom'))).toBe(false);
  });
  it('shows the server message, or the contract text when the server message is not safe to show', () => {
    expect(confirmationDeadlineMessage(refusal(CONFIRMATION_DEADLINE_MESSAGES.CONFIRM_REPLACEMENT))).toBe(CONFIRMATION_DEADLINE_MESSAGES.CONFIRM_REPLACEMENT);
    expect(confirmationDeadlineMessage(refusal('QueryFailedError: relation "job_offer"'))).toBe(CONFIRMATION_DEADLINE_MESSAGES.CONFIRM);
    expect(confirmationDeadlineMessage(refusal(undefined), CONFIRMATION_DEADLINE_MESSAGES.SEND)).toBe(CONFIRMATION_DEADLINE_MESSAGES.SEND);
  });
});
