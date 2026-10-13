import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateProfileScreen from './CreateProfileScreen';
import { api } from '../../shared/api';
import { PENDING_MANAGER_WELCOME_KEY } from './onboardingMotion';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;

function mountAt(path = '/onboarding/profile') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/onboarding/profile" element={<CreateProfileScreen />} />
          <Route path="/onboarding/preparing" element={<div>PREPARING</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  post.mockReset();
  patch.mockReset();
  patch.mockResolvedValue({ data: { firstName: 'Issac', lastName: 'N', jobTitle: null } });
  post.mockImplementation((url: string) => {
    if (url === '/manager-workspaces/me/complete-onboarding') return Promise.resolve({ data: { id: 'ws-1', schemaStatus: 'CREATING' } });
    throw new Error(`unexpected POST ${url}`);
  });
});

describe('validation — empty submit never does nothing silently', () => {
  it('shows both required-field errors and focuses first name first', async () => {
    mountAt();
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    expect(await screen.findByText('First name is required.')).toBeInTheDocument();
    expect(screen.getByText('Last name is required.')).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveFocus();
    expect(patch).not.toHaveBeenCalled();
  });

  it('only first name missing — just that error shows, and focus lands there', async () => {
    mountAt();
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Ng' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    expect(await screen.findByText('First name is required.')).toBeInTheDocument();
    expect(screen.queryByText('Last name is required.')).toBeNull();
    expect(screen.getByLabelText('First name')).toHaveFocus();
  });

  it('only last name missing — just that error shows, and focus lands there', async () => {
    mountAt();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    expect(await screen.findByText('Last name is required.')).toBeInTheDocument();
    expect(screen.queryByText('First name is required.')).toBeNull();
    expect(screen.getByLabelText('Last name')).toHaveFocus();
  });

  it('clears each error the moment its own field becomes valid', async () => {
    mountAt();
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    await screen.findByText('First name is required.');
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    expect(screen.queryByText('First name is required.')).toBeNull();
    expect(screen.getByText('Last name is required.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Ng' } });
    expect(screen.queryByText('Last name is required.')).toBeNull();
  });
});

describe('successful submission and backend errors', () => {
  it('a valid submission with no job title still proceeds — job title is optional', async () => {
    mountAt();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Ng' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    await waitFor(() => expect(screen.getByText('PREPARING')).toBeInTheDocument());
    expect(patch).toHaveBeenCalledWith('/profile', { firstName: 'Issac', lastName: 'Ng', jobTitle: undefined });
    // The one-time welcome trigger is bound to the server-confirmed workspace id.
    expect(sessionStorage.getItem(PENDING_MANAGER_WELCOME_KEY)).toBe('ws-1');
  });

  it('a backend profile-update failure shows the real server error and stays on the form', async () => {
    patch.mockRejectedValue({ response: { status: 500, data: { message: 'Could not save your profile right now.' } } });
    mountAt();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Ng' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    expect(await screen.findByText('Could not save your profile right now.')).toBeInTheDocument();
    expect(screen.queryByText('PREPARING')).toBeNull();
    expect(sessionStorage.getItem(PENDING_MANAGER_WELCOME_KEY)).toBeNull();
  });

  it('Enter-key submission runs the same validation as a click', async () => {
    mountAt();
    const form = screen.getByLabelText('First name').closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText('First name is required.')).toBeInTheDocument();
  });

  it('prevents a duplicate submission while the request is already in flight', async () => {
    let resolvePatch: (v: unknown) => void;
    const pending = new Promise((resolve) => { resolvePatch = resolve; });
    patch.mockReturnValue(pending);
    mountAt();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Ng' } });
    const button = screen.getByRole('button', { name: 'Complete setup' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button); // second click while disabled/in-flight — must not fire a second PATCH
    resolvePatch!({ data: { firstName: 'Issac', lastName: 'Ng', jobTitle: null } });
    await waitFor(() => expect(screen.getByText('PREPARING')).toBeInTheDocument());
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('preserves entered values after a validation error instead of clearing the form', async () => {
    mountAt();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
    await screen.findByText('Last name is required.');
    expect(screen.getByLabelText('First name')).toHaveValue('Issac');
  });
});
