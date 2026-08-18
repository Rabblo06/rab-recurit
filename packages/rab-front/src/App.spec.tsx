import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';
import { api } from './api';

jest.mock('./api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };

async function fillLoginStepOne(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'admin@acme.test');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  // The email→password step transition runs through framer-motion's
  // AnimatePresence — the Password field isn't in the DOM synchronously
  // after the click, so wait for it rather than a plain getByLabelText.
  await screen.findByLabelText('Password');
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    window.history.pushState({}, '', '/');
  });

  it('redirects an unauthenticated visitor to the login form', () => {
    render(<App />);
    expect(screen.getByText('Sign in to rab')).toBeInTheDocument();
  });

  it('shows the API error message on failed login', async () => {
    mockApi.post.mockRejectedValue({ response: { data: { message: 'Invalid email or password.' } } });
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    // A failed login stays on the password step (not bounced back to the
    // email step) — the "Enter your password" heading is that step's title.
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
  });

  it('stores tokens and renders the console after a successful login', async () => {
    mockApi.post.mockResolvedValue({ data: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') {
        return Promise.resolve({
          data: { id: '1', email: 'admin@acme.test', firstName: 'Super', lastName: 'Admin', roles: ['super_admin'] },
        });
      }
      // /staff, /managers, /venues — Dashboard queries all three.
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(window.localStorage.getItem('accessToken')).toBe('access-1'));
    expect(window.localStorage.getItem('refreshToken')).toBe('refresh-1');
    // Layout's route transition also runs through framer-motion's
    // AnimatePresence, on top of the login step transition already waited
    // for above — give it more room than the default 1000ms. "Dashboard"
    // legitimately appears twice (sidebar nav link + topbar tab).
    expect(await screen.findAllByText('Dashboard', {}, { timeout: 3000 })).not.toHaveLength(0);
  });
});
