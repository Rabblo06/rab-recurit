import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../shared/api';
import AcceptInvitation from './AcceptInvitation';

jest.mock('../../shared/api', () => ({ api: { post: jest.fn(), get: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const post = api.post as jest.Mock;
const get = api.get as jest.Mock;

function mount(token = 'tok_' + 'a'.repeat(40)) {
  render(<MemoryRouter initialEntries={[`/accept-invitation?token=${token}`]}><AcceptInvitation /></MemoryRouter>);
}

beforeEach(() => {
  post.mockReset();
  get.mockReset().mockResolvedValue({ data: { invitationProviders: { google: false, microsoft: false } } });
});

it('offers "Accept with Google" only when the server enables it, as a form POST that keeps the token out of the URL', async () => {
  post.mockResolvedValue({ data: { email: 'ada@example.test', roleLabel: 'Supervisor', workspaceName: 'Northwind' } });
  get.mockResolvedValue({ data: { invitationProviders: { google: true, microsoft: false } } });
  mount();
  const button = await screen.findByRole('button', { name: 'Accept with Google' });
  const form = button.closest('form')!;
  expect(form).toHaveAttribute('method', 'post');
  expect(form).toHaveAttribute('action', 'http://api.test/rest/v1/auth/google/invitation');
  expect(form.querySelector('input[name="token"]')).toHaveValue('tok_' + 'a'.repeat(40));
  expect(screen.queryByRole('button', { name: 'Accept with Microsoft' })).toBeNull();
  // The password path is still available.
  expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
});

it('hides provider acceptance when the server does not enable it', async () => {
  post.mockResolvedValue({ data: { email: 'ada@example.test', roleLabel: 'Supervisor', workspaceName: 'Northwind' } });
  mount();
  expect(await screen.findByRole('heading', { name: 'Join Northwind' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Accept with/ })).toBeNull();
});

it('a failed provider acceptance explains how to retry, in red', async () => {
  render(<MemoryRouter initialEntries={['/accept-invitation?oauthError=1']}><AcceptInvitation /></MemoryRouter>);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/choose the account that matches the invited email address/);
  expect(post).not.toHaveBeenCalled();
});

it('the recipient enters their OWN first name, last name and password, then is sent to the right app', async () => {
  post.mockImplementation((url: string) => {
    if (url === '/invitations/resolve') return Promise.resolve({ data: { email: 'ada@example.test', roleLabel: 'Staff', workspaceName: 'Northwind Staffing' } });
    return Promise.resolve({ data: { applicationTarget: 'staff_app', managerLoginUrl: 'http://app/login' } });
  });
  mount();
  expect(await screen.findByRole('heading', { name: 'Join Northwind Staffing' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('ada@example.test');
  expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
  const submit = screen.getByRole('button', { name: 'Accept invitation' });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Ada ' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lovelace' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-42-battery' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Correct-Horse-42-battery' } });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() =>
    // Test-only fixture password, not a credential.
    expect(post).toHaveBeenCalledWith('/invitations/accept', { token: 'tok_' + 'a'.repeat(40), firstName: 'Ada', lastName: 'Lovelace', newPassword: 'Correct-Horse-42-battery' }), // gitleaks:allow
  );
  expect(await screen.findByText(/sign in using the ADOLPHUS mobile app/)).toBeInTheDocument();
});

it('an invalid, expired or used link shows one generic message and no form', async () => {
  post.mockRejectedValue({ response: { status: 400, data: { message: 'This invitation link is invalid or has expired.' } } });
  mount();
  expect(await screen.findByRole('heading', { name: 'This invitation can’t be used' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Password')).toBeNull();
});

it('throttling or an outage is retryable and never claims the link is invalid', async () => {
  post
    .mockRejectedValueOnce({ response: { status: 429, data: { message: 'ThrottlerException: Too Many Requests' } } })
    .mockResolvedValueOnce({ data: { email: 'ada@example.test', roleLabel: 'Staff', workspaceName: 'Northwind Staffing' } });
  mount();
  expect(await screen.findByRole('heading', { name: 'We couldn’t check your invitation' })).toBeInTheDocument();
  expect(screen.queryByText(/invalid or has expired/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'Join Northwind Staffing' })).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(2);
});

it('a missing token never calls the API', () => {
  render(<MemoryRouter initialEntries={['/accept-invitation']}><AcceptInvitation /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'This invitation can’t be used' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});

it('server-side refusal (e.g. password policy) is shown as an error and the form stays filled', async () => {
  post.mockImplementation((url: string) =>
    url === '/invitations/resolve'
      ? Promise.resolve({ data: { email: 'ada@example.test', roleLabel: 'Staff', workspaceName: null } })
      : Promise.reject({ response: { status: 400, data: { message: 'Password must not contain your email.' } } }),
  );
  mount();
  await screen.findByRole('heading', { name: 'Join your team' });
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lovelace' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-42-battery' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Correct-Horse-42-battery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Password must not contain your email.');
  expect(screen.getByLabelText('First name')).toHaveValue('Ada');
});

it('owner correction: a CEO (organisation) invitation asks for the CEO’s own names AND the organisation name; no provider shortcut', async () => {
  get.mockResolvedValue({ data: { invitationProviders: { google: true, microsoft: true } } });
  post.mockImplementation((url: string) => {
    if (url === '/invitations/resolve') return Promise.resolve({ data: { kind: 'organisation', email: 'cleo@example.test', roleLabel: 'CEO', workspaceName: null } });
    return Promise.resolve({ data: { applicationTarget: 'manager_web', managerLoginUrl: 'http://app/login' } });
  });
  mount();
  expect(await screen.findByRole('heading', { name: 'Set up your organisation' })).toBeInTheDocument();
  expect(screen.getByText(/invited as the CEO/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Accept with Google/ })).toBeNull();
  const submit = screen.getByRole('button', { name: 'Accept invitation' });
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Cleo' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Example' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-42-battery' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Correct-Horse-42-battery' } });
  expect(submit).toBeDisabled(); // the organisation name is required
  fireEvent.change(screen.getByLabelText('Organisation name'), { target: { value: ' Northwind Staffing ' } });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() =>
    // Test-only fixture password, not a credential.
    expect(post).toHaveBeenCalledWith('/invitations/accept', { token: 'tok_' + 'a'.repeat(40), firstName: 'Cleo', lastName: 'Example', organisationName: 'Northwind Staffing', newPassword: 'Correct-Horse-42-battery' }), // gitleaks:allow
  );
});

it('a workspace-member invitation never shows or sends an organisation name', async () => {
  post.mockImplementation((url: string) => {
    if (url === '/invitations/resolve') return Promise.resolve({ data: { email: 'ada@example.test', roleLabel: 'Staff', workspaceName: 'Northwind' } });
    return Promise.resolve({ data: { applicationTarget: 'manager_web' } });
  });
  mount();
  await screen.findByRole('heading', { name: 'Join Northwind' });
  expect(screen.queryByLabelText('Organisation name')).toBeNull();
});
