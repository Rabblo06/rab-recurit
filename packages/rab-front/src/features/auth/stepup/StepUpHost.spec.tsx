import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { api, registerStepUpHandler } from '../../../shared/api';
import StepUpHost from './StepUpHost';

jest.mock('../../../shared/api', () => ({
  api: { post: jest.fn() },
  registerStepUpHandler: jest.fn(),
}));

const post = api.post as jest.Mock;
const register = registerStepUpHandler as jest.Mock;
type Handler = (challenge: { mfa: boolean }) => Promise<boolean>;

function mount(): Handler {
  register.mockReset().mockImplementation(() => () => undefined);
  render(<StepUpHost />);
  return register.mock.calls[0]![0] as Handler;
}

beforeEach(() => post.mockReset());

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
