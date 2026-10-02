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

it('Staff activation shows the mobile-app message and link — never a Manager dashboard redirect', async () => {
  post.mockResolvedValue({ data: { applicationTarget: 'staff_app', managerLoginUrl: 'https://app.rabworkspaceteams.co.uk/login' } });
  render(<MemoryRouter initialEntries={['/activate-account?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('status')).toHaveTextContent('Your account setup is complete');
  expect(screen.getByText('You can now sign in using the ADOLPHUS mobile app.')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'Open the app' });
  expect(link).toHaveAttribute('href', 'rab://login');
  expect(screen.queryByText('Continue to Manager Portal')).toBeNull();
  expect(screen.queryByLabelText('New password')).toBeNull();
});

it('Venue Manager activation shows the mobile-app message and link — never a Manager dashboard redirect', async () => {
  post.mockResolvedValue({ data: { applicationTarget: 'venue_manager_app', managerLoginUrl: 'https://app.rabworkspaceteams.co.uk/login' } });
  render(<MemoryRouter initialEntries={['/activate-account?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('status')).toHaveTextContent('Your account setup is complete');
  expect(screen.getByText('You can now sign in using the ADOLPHUS mobile app.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', 'rab://login');
  expect(screen.queryByText('Continue to Manager Portal')).toBeNull();
});

it('Manager/CEO activation shows a "Continue to Manager Portal" link to the absolute Manager app URL', async () => {
  post.mockResolvedValue({ data: { applicationTarget: 'manager_web', managerLoginUrl: 'https://app.rabworkspaceteams.co.uk/login' } });
  render(<MemoryRouter initialEntries={['/activate-account?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('status')).toHaveTextContent('Your account setup is complete');
  const link = screen.getByRole('link', { name: 'Continue to Manager Portal' });
  expect(link).toHaveAttribute('href', 'https://app.rabworkspaceteams.co.uk/login');
  expect(screen.queryByText('You can now sign in using the ADOLPHUS mobile app.')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByLabelText('New password')).toBeNull();
});

it('falls back to the plain "Go back to login" text if the server response is somehow missing applicationTarget', async () => {
  post.mockResolvedValue({ data: undefined });
  render(<MemoryRouter initialEntries={['/activate-account?token=fixture']}><ActivateAccount /></MemoryRouter>);
  await submit('Activate account');
  expect(await screen.findByRole('status')).toHaveTextContent('Your account setup is complete');
  expect(screen.getByText('Go back to login')).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
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

it('SetPassword (authenticated forced-reset) keeps its own fixed "Go back to login" link, unaffected by role', async () => {
  post.mockResolvedValue({ data: {} });
  render(<MemoryRouter initialEntries={['/?token=fixture']}><SetPassword /></MemoryRouter>);
  await submit('Update password');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password updated successfully'));
  expect(screen.queryByRole('button')).toBeNull();
  const link = screen.getByRole('link', { name: 'Go back to login' });
  expect(link).toHaveAttribute('href', '/login');
});

it('ResetPassword for Staff/Venue Manager shows the mobile-app message, never a Manager dashboard link', async () => {
  post.mockResolvedValue({ data: { applicationTarget: 'staff_app', managerLoginUrl: 'https://app.rabworkspaceteams.co.uk/login' } });
  render(<MemoryRouter initialEntries={['/?token=fixture']}><ResetPassword /></MemoryRouter>);
  await submit('Update password');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password updated successfully'));
  expect(screen.getByText('You can now sign in using the ADOLPHUS mobile app.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', 'rab://login');
  expect(screen.queryByText('Continue to Manager Portal')).toBeNull();
});

it('ResetPassword for Manager shows a "Continue to Manager Portal" link to the absolute Manager app URL', async () => {
  post.mockResolvedValue({ data: { applicationTarget: 'manager_web', managerLoginUrl: 'https://app.rabworkspaceteams.co.uk/login' } });
  render(<MemoryRouter initialEntries={['/?token=fixture']}><ResetPassword /></MemoryRouter>);
  await submit('Update password');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password updated successfully'));
  const link = screen.getByRole('link', { name: 'Continue to Manager Portal' });
  expect(link).toHaveAttribute('href', 'https://app.rabworkspaceteams.co.uk/login');
});
