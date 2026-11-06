import { CONFIRMATION_DEADLINE_MESSAGES } from '@rab/shared';
import { confirmAllSummary } from './confirm-all-summary';

it('all confirmed / none left are unchanged', () => {
  expect(confirmAllSummary([{ ok: true }, { ok: true }])).toEqual({ text: '2 shifts confirmed.', partial: false });
  expect(confirmAllSummary([])).toEqual({ text: 'There were no accepted offers left to confirm.', partial: false });
});

it('failures that share one server reason (the confirmation deadline) show that reason', () => {
  expect(confirmAllSummary([{ ok: true }, { ok: false, message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM }, { ok: false, message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM }])).toEqual({
    text: `1 of 3 accepted offers confirmed. ${CONFIRMATION_DEADLINE_MESSAGES.CONFIRM}`,
    partial: true,
  });
});

it('mixed, missing or unsafe reasons fall back to the general text', () => {
  const general = '0 of 2 accepted offers confirmed. The rest could not be confirmed (the shift may be full or the offer changed).';
  expect(confirmAllSummary([{ ok: false, message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM }, { ok: false, message: 'This shift is already full.' }]).text).toBe(general);
  expect(confirmAllSummary([{ ok: false }, { ok: false }]).text).toBe(general);
  expect(confirmAllSummary([{ ok: false, message: 'QueryFailedError: deadlock detected' }, { ok: false, message: 'QueryFailedError: deadlock detected' }]).text).toBe(general);
});
