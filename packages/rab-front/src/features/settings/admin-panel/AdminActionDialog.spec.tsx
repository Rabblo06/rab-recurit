import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminActionDialog from './AdminActionDialog';

function setup(onConfirm = jest.fn().mockResolvedValue(undefined), props: Partial<Parameters<typeof AdminActionDialog>[0]> = {}) {
  const onClose = jest.fn();
  const opener = document.createElement('button');
  opener.textContent = 'opener';
  document.body.appendChild(opener);
  opener.focus();
  const view = render(<AdminActionDialog title="Sign Sam out everywhere" body="Ends every session." confirmLabel="Sign out everywhere" onConfirm={onConfirm} onClose={onClose} {...props} />);
  return { onConfirm, onClose, opener, ...view };
}

afterEach(() => {
  document.body.innerHTML = '';
});

it('is a labelled modal dialog with reason, password and the optional 2FA code fields; focus moves inside', () => {
  setup();
  const dialog = screen.getByRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(screen.getByLabelText('Reason (saved to the audit log)')).toBeTruthy();
  expect(screen.getByLabelText('Your password')).toBeTruthy();
  expect(screen.getByLabelText('Your 2FA code (only if you use 2FA)')).toBeTruthy();
  expect(dialog.contains(document.activeElement)).toBe(true);
});

it('refuses a reason shorter than 3 characters (client-side; the server re-checks)', async () => {
  const { onConfirm } = setup();
  fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'ab' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('submits trimmed reason + password + code once; the button is disabled while pending (no double submit)', async () => {
  let resolve!: () => void;
  const onConfirm = jest.fn(() => new Promise<void>((r) => (resolve = r)));
  setup(onConfirm);
  fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: '  Lost laptop  ' } });
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
  fireEvent.change(screen.getByLabelText('Your 2FA code (only if you use 2FA)'), { target: { value: '123 456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: 'Lost laptop', currentPassword: 'pw', code: '123456', extra: '' }));
  expect((screen.getByRole('button', { name: 'Please wait…' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Please wait…' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  resolve();
});

it('Escape closes and focus returns to the opener', () => {
  const { onClose, opener, unmount } = setup();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
  unmount();
  expect(document.activeElement).toBe(opener);
});

it('traps Tab focus inside the dialog', () => {
  setup();
  const buttons = screen.getAllByRole('button');
  const last = buttons[buttons.length - 1]!;
  last.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(last);
});

it('maps a server error code to clear text and stays open', async () => {
  const onConfirm = jest.fn().mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { code: 'MFA_RESET_REQUIRES_SECOND_ADMIN', message: 'x' } } });
  setup(onConfirm, { errorText: { MFA_RESET_REQUIRES_SECOND_ADMIN: 'Needs a second administrator.' } });
  fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'valid reason' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Needs a second administrator.');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('an extra typed confirmation (the organisation slug) must match exactly', async () => {
  const { onConfirm } = setup(undefined, { extraField: { label: 'Type the slug', mustEqual: 'example-agency' }, passwordRequired: true });
  fireEvent.change(screen.getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Contract ended' } });
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
  fireEvent.change(screen.getByLabelText('Type the slug'), { target: { value: 'example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(onConfirm).not.toHaveBeenCalled();
});
