import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ActivateAccount from './ActivateAccount';
import ResetPassword from './ResetPassword';
import SetPassword from './SetPassword';
import { api } from '../../shared/api';

jest.mock('../../shared/api', () => ({ api: { post: jest.fn() } }));
const post = api.post as jest.Mock;
beforeEach(() => post.mockReset());

async function submit(label: string) {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'StrongPassword123!' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'StrongPassword123!' } });
  fireEvent.click(screen.getByRole('button', { name: label }));
}

it.each(['Staff', 'Venue Manager', 'Internal Manager'])('%s invitation stays on neutral setup success', async () => {
  post.mockResolvedValue({ data: undefined });
  render(<MemoryRouter initialEntries={['/activate-account?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('status')).toHaveTextContent('Your account setup is complete');
  expect(screen.getByText('Go back to login')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByLabelText('New password')).toBeNull();
});

it.each(['invalid', 'expired', 'already used'])('keeps %s token errors on the form', async reason => {
  post.mockRejectedValue({ response: { data: { message: `This activation link is ${reason}.` } } });
  render(<MemoryRouter initialEntries={['/?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('alert')).toHaveTextContent(reason);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByLabelText('New password')).toBeInTheDocument();
});

it('reports a network failure without displaying success', async () => {
  post.mockRejectedValue(new Error('Network unavailable'));
  render(<MemoryRouter initialEntries={['/?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to activate your account right now');
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([ResetPassword, SetPassword])('password update replaces the form with success and a text link', async Component => {
  post.mockResolvedValue({ data: { applicationTarget: 'staff_app' } });
  render(<MemoryRouter initialEntries={['/?token=fixture']}><Component /></MemoryRouter>);
  await submit('Update password');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password updated successfully'));
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('link', { name: 'Go back to login' })).toBeInTheDocument();
});
