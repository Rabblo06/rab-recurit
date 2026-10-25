import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { api, registerStepUpHandler } from '../../../shared/api';
import StepUpHost from './StepUpHost';

jest.mock('../../../shared/api', () => ({
  api: { post: jest.fn(), get: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } },
  registerStepUpHandler: jest.fn(),
}));

const post = api.post as jest.Mock;
const get = api.get as jest.Mock;
const register = registerStepUpHandler as jest.Mock;
type Handler = (challenge: { mfa: boolean }) => Promise<boolean>;

function mount(): Handler {
  register.mockReset().mockImplementation(() => () => undefined);
  render(<StepUpHost />);
  return register.mock.calls[0]![0] as Handler;
}

beforeEach(() => {
  post.mockReset();
  // A password account by default (what GET /auth/mfa answers for it).
  get.mockReset().mockResolvedValue({ data: { hasPassword: true, ssoReauthProviders: [] } });
});

it('MFA-enrolled account: collects password AND the six-digit code, posts /auth/step-up, resolves true', async () => {
  const handler = mount();
  let result: Promise<boolean> | undefined;
  act(() => {
    result = handler({ mfa: true });
  });
  expect(await screen.findByRole('heading', { name: 'Confirm it’s you' })).toBeInTheDocument();
  const submit = screen.getByRole('button', { name: 'Continue' });
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
  expect(submit).toBeDisabled(); // the code is required too
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123 456' } });
  post.mockResolvedValue({ data: { validUntil: 'x', mfa: true } });
  fireEvent.click(submit);
  await expect(result).resolves.toBe(true);
  expect(post).toHaveBeenCalledWith('/auth/step-up', { currentPassword: 'pw', code: '123456' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('account without MFA: password only (no code field, no code sent)', async () => {
  const handler = mount();
  let result: Promise<boolean> | undefined;
  act(() => {
    result = handler({ mfa: false });
  });
  await screen.findByRole('dialog');
  expect(screen.queryByLabelText('Six-digit code')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
  post.mockResolvedValue({ data: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await expect(result).resolves.toBe(true);
  expect(post).toHaveBeenCalledWith('/auth/step-up', { currentPassword: 'pw' });
});

it('a refused proof stays open with the server’s message (and asks for the code if the server says so); Cancel resolves false', async () => {
  const handler = mount();
  let result: Promise<boolean> | undefined;
  act(() => {
    result = handler({ mfa: false });
  });
  await screen.findByRole('dialog');
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'wrong' } });
  post.mockRejectedValue(Object.assign(new Error('403'), { isAxiosError: true, response: { status: 403, data: { code: 'STEP_UP_MFA_INVALID', message: 'That code didn’t work. Enter the current code from your authenticator app.' } } }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByLabelText('Six-digit code')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await expect(result).resolves.toBe(false);
});

it('step 1 (P6): an account WITHOUT a password gets “Continue with Microsoft” (a top-level form POST to the re-auth route) and no password field', async () => {
  get.mockResolvedValue({ data: { hasPassword: false, ssoReauthProviders: ['microsoft'] } });
  const handler = mount();
  act(() => {
    void handler({ mfa: false });
  });
  const button = await screen.findByRole('button', { name: 'Continue with Microsoft' });
  const form = button.closest('form')!;
  expect(form).toHaveAttribute('method', 'post');
  expect(form).toHaveAttribute('action', 'http://api.test/rest/v1/auth/microsoft/reauthenticate');
  expect(screen.queryByLabelText('Your current password')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Verify code' })).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});

it('step 1 (P6): an ENROLLED account without a password finishes the step-up with its code only (POST /auth/step-up {code})', async () => {
  get.mockResolvedValue({ data: { hasPassword: false, ssoReauthProviders: ['microsoft'] } });
  const handler = mount();
  let result: Promise<boolean> | undefined;
  act(() => {
    result = handler({ mfa: true });
  });
  await screen.findByRole('button', { name: 'Continue with Microsoft' });
  const verify = screen.getByRole('button', { name: 'Verify code' });
  expect(verify).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '654321' } });
  post.mockResolvedValue({ data: { validUntil: 'x', mfa: true } });
  fireEvent.click(verify);
  await expect(result).resolves.toBe(true);
  expect(post).toHaveBeenCalledWith('/auth/step-up', { code: '654321' });
});

it('falls back to the password form when the account info cannot be read (the server decides anyway)', async () => {
  get.mockRejectedValue(new Error('offline'));
  const handler = mount();
  act(() => {
    void handler({ mfa: false });
  });
  expect(await screen.findByLabelText('Your current password')).toBeInTheDocument();
  await waitFor(() => expect(get).toHaveBeenCalledWith('/auth/mfa'));
  expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
});

describe('feedback follow-up (FEEDBACK_REPORT §6, Auth + MFA item 10)', () => {
  const open = async (mfa: boolean) => {
    const handler = mount();
    act(() => {
      void handler({ mfa });
    });
    await screen.findByRole('dialog');
  };

  it('a double submit posts once (synchronous guard), with "Please wait…" while it runs', async () => {
    await open(false);
    fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
    post.mockReturnValue(new Promise(() => undefined));
    const form = screen.getByRole('button', { name: 'Continue' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(await screen.findByRole('button', { name: 'Please wait…' })).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a wrong password: the alert is linked to the password field (aria-invalid + aria-describedby) and focus returns there; the password is kept', async () => {
    await open(false);
    const password = screen.getByLabelText('Your current password');
    fireEvent.change(password, { target: { value: 'wrong' } });
    post.mockRejectedValueOnce(Object.assign(new Error('403'), { isAxiosError: true, response: { status: 403, data: { message: 'Re-enter your current password to continue.' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Re-enter your current password to continue.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-describedby', alert.id);
    expect(password).toHaveValue('wrong');
    await waitFor(() => expect(password).toHaveFocus());
  });

  it('a wrong code: the alert is linked to the code field instead (not the password)', async () => {
    await open(true);
    fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
    post.mockRejectedValueOnce(Object.assign(new Error('403'), { isAxiosError: true, response: { status: 403, data: { code: 'STEP_UP_MFA_INVALID', message: 'That code didn’t work. Enter the current code from your authenticator app.' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    const code = screen.getByLabelText('Six-digit code');
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code).toHaveAttribute('aria-describedby', alert.id);
    expect(screen.getByLabelText('Your current password')).not.toHaveAttribute('aria-invalid');
    await waitFor(() => expect(code).toHaveFocus());
  });

  it('"Continue with Microsoft" is submitted once: a second submit is prevented and the button is disabled', async () => {
    get.mockResolvedValue({ data: { hasPassword: false, ssoReauthProviders: ['microsoft'] } });
    await open(false);
    const button = await screen.findByRole('button', { name: 'Continue with Microsoft' });
    const form = button.closest('form')!;
    const first = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false); // the real top-level POST goes ahead
    expect(await screen.findByRole('button', { name: 'Opening Microsoft…' })).toBeDisabled();
    const second = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
  });
});
