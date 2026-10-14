import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../shared/api';
import AcceptInvitation from './AcceptInvitation';

jest.mock('../../shared/api', () => ({ api: { post: jest.fn() } }));
const post = api.post as jest.Mock;

function mount(token = 'tok_' + 'a'.repeat(40)) {
  render(<MemoryRouter initialEntries={[`/accept-invitation?token=${token}`]}><AcceptInvitation /></MemoryRouter>);
}

beforeEach(() => post.mockReset());

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
    expect(post).toHaveBeenCalledWith('/invitations/accept', { token: 'tok_' + 'a'.repeat(40), firstName: 'Ada', lastName: 'Lovelace', newPassword: 'Correct-Horse-42-battery' }),
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
