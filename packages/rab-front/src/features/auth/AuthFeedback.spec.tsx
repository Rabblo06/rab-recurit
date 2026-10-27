import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import { api } from '../../shared/api';
import { TOAST_EVENT, type ToastDetail } from '../../shared/lib/toast';
import AcceptInvitation from './AcceptInvitation';
import ActivateAccount from './ActivateAccount';
import ForgotPassword from './ForgotPassword';
import Login from './Login';
import ResetPassword from './ResetPassword';
import SetPassword from './SetPassword';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } },
  withAuthLock: jest.fn((run: () => unknown) => run()),
  resolveIdentityViaCookie: jest.fn().mockResolvedValue(true),
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
}));

/**
 * Feedback follow-up (FEEDBACK_REPORT §6, Auth + MFA items 1-4): the sign-in, forgot-password and set-password screens.
 * Owner rule: busy label + duplicate submits blocked, success only after the server, one announcement per error with
 * the field linked to it, input kept, expired session → persistent "Sign in again", never a hint that an email exists.
 */
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const httpError = (status: number, data: unknown = {}, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data, headers } });
const STRONG = 'Correct-Horse-9-battery';

let toasts: ToastDetail[] = [];
const onToast = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);
beforeEach(() => {
  toasts = [];
  document.addEventListener(TOAST_EVENT, onToast);
  get.mockReset().mockResolvedValue({ data: { authProviders: { password: true, google: false, microsoft: false } } });
  post.mockReset();
});
afterEach(() => document.removeEventListener(TOAST_EVENT, onToast));

function renderAt(path: string, ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function toPasswordStep(email = 'ada@example.test') {
  renderAt('/login', <Login />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
  fireEvent.change(await screen.findByLabelText('Work email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return screen.findByLabelText('Password');
}

describe('Login (item 1 + 2)', () => {
  it('a wrong email and a wrong password render the IDENTICAL screen; both fields are invalid and described by the one alert; input kept; no toast', async () => {
    const uniform = httpError(401, { statusCode: 401, message: 'Invalid email or password.', error: 'Unauthorized' });
    const screens: string[] = [];
    for (const email of ['nobody@example.test', 'ada@example.test']) {
      post.mockReset().mockRejectedValueOnce(uniform);
      const password = await toPasswordStep(email);
      fireEvent.change(password, { target: { value: 'wrong-password' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The email or password is incorrect. Check your details and try again.');
      for (const label of ['Work email', 'Password']) {
        const input = screen.getByLabelText(label);
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(input).toHaveAttribute('aria-describedby', alert.id);
      }
      expect(screen.getByLabelText('Password')).toHaveValue('wrong-password');
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      screens.push(alert.textContent ?? '');
      document.body.replaceChildren(); // the next attempt starts from a fresh screen
    }
    expect(screens[0]).toBe(screens[1]);
    expect(toasts).toEqual([]);
  });

  it('AMBIGUOUS_ACCOUNTS (post-verification code) shows its own message', async () => {
    post.mockRejectedValueOnce(httpError(401, { code: 'AMBIGUOUS_ACCOUNTS', message: 'x' }));
    fireEvent.change(await toPasswordStep(), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('belongs to more than one Crewflow account');
  });

  it('a rate limit is linked to the fields but does not mark them invalid (it says nothing about the input)', async () => {
    post.mockRejectedValueOnce(httpError(429, {}, { 'retry-after': '120' }));
    fireEvent.change(await toPasswordStep(), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many sign-in attempts. Please try again in 2 minutes.');
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', alert.id);
  });
});

describe('Forgot password (item 3)', () => {
  const mount = () => {
    renderAt('/forgot-password', <ForgotPassword />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
  };

  it('a double click sends ONE request; "Sending…" while it runs', async () => {
    let finish: (v: unknown) => void = () => undefined;
    post.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    mount();
    const button = screen.getByRole('button', { name: 'Send reset link' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
    finish({ data: {} });
    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
  });

  it('429 says to wait (not "check your connection"); 5xx says try again; neither marks the field invalid', async () => {
    post.mockRejectedValueOnce(httpError(429, { message: 'ThrottlerException: Too Many Requests' }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Please wait a few minutes, then try again.');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    post.mockRejectedValueOnce(httpError(503, { message: 'Internal server error' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t send the request right now. Please try again in a moment.'));
  });

  it('a refused address (400) marks the field invalid and links it to the alert; the address is kept', async () => {
    post.mockRejectedValueOnce(httpError(400, { message: ['email must be an email'] }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Enter a valid email address, then try again.');
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', alert.id);
    expect(screen.getByLabelText('Email')).toHaveValue('person@example.test');
  });
});

describe('Password forms (item 4)', () => {
  const forms: Array<[string, string, ReactElement, string, string, string]> = [
    ['ResetPassword', '/reset-password?token=t1', <ResetPassword key="r" />, 'New password', 'Confirm password', 'Reset password'],
    ['ActivateAccount', '/activate-account?token=t1', <ActivateAccount key="a" />, 'New password', 'Confirm password', 'Set password'],
    ['SetPassword', '/set-password', <SetPassword key="s" />, 'New password', 'Confirm password', 'Set password'],
  ];

  it.each(forms)('%s: a weak password is linked to its requirement list; a mismatch is linked to the confirm field and announced once (polite)', async (_name, path, ui, pwLabel, confirmLabel) => {
    renderAt(path, ui);
    const pw = screen.getByLabelText(pwLabel);
    fireEvent.change(pw, { target: { value: 'short' } });
    expect(pw).toHaveAttribute('aria-invalid', 'true');
    const list = document.getElementById(pw.getAttribute('aria-describedby')!)!;
    expect(list.tagName).toBe('UL');
    fireEvent.change(pw, { target: { value: STRONG } });
    expect(pw).not.toHaveAttribute('aria-invalid');
    const confirm = screen.getByLabelText(confirmLabel);
    fireEvent.change(confirm, { target: { value: `${STRONG}x` } });
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    const mismatch = document.getElementById(confirm.getAttribute('aria-describedby')!)!;
    expect(mismatch).toHaveTextContent('Passwords don\'t match.');
    expect(mismatch.parentElement).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(forms)('%s: a double submit sends ONE request', async (_name, path, ui, pwLabel, confirmLabel, submitLabel) => {
    post.mockReturnValue(new Promise(() => undefined));
    renderAt(path, ui);
    fireEvent.change(screen.getByLabelText(pwLabel), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: STRONG } });
    const form = screen.getByRole('button', { name: submitLabel }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it('SetPassword: both inputs carry autocomplete="new-password"', () => {
    renderAt('/set-password', <SetPassword />);
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('SetPassword: an expired session (401) is ONE persistent "Sign in again" toast, no inline alert; the passwords are kept', async () => {
    post.mockRejectedValueOnce(httpError(401, { message: 'Unauthorized' }));
    renderAt('/set-password', <SetPassword />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({ variant: 'error', persistent: true, message: 'Your session has expired. Please sign in again.' });
    expect(toasts[0]!.action?.label).toBe('Sign in again');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('New password')).toHaveValue(STRONG);
  });

  it('AcceptInvitation: the mismatch is linked to the confirm field and announced politely', async () => {
    post.mockResolvedValueOnce({ data: { email: 'new@example.test', roleLabel: 'Supervisor', workspaceName: 'Northwind' } });
    get.mockResolvedValue({ data: {} });
    renderAt('/accept-invitation?token=t1', <AcceptInvitation />);
    const confirm = await screen.findByLabelText('Confirm password');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: STRONG } });
    fireEvent.change(confirm, { target: { value: 'different' } });
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    const mismatch = document.getElementById(confirm.getAttribute('aria-describedby')!)!;
    expect(mismatch).toHaveTextContent('Passwords don\'t match.');
    expect(mismatch.parentElement).toHaveAttribute('aria-live', 'polite');
  });
});
