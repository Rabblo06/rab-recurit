import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateWorkspaceScreen from './CreateWorkspaceScreen';
import { api } from '../../shared/api';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

function mountAt(path = '/onboarding/workspace') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/onboarding/workspace" element={<CreateWorkspaceScreen />} />
          <Route path="/onboarding/profile" element={<div>PROFILE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function availableCheck(candidate: string) {
  return { available: true, normalized: candidate, reserved: false };
}
function takenCheck(candidate: string) {
  return { available: false, normalized: candidate, reserved: false, suggested: `${candidate}01` };
}
function reservedCheck(candidate: string) {
  return { available: false, normalized: candidate, reserved: true };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  // useDomainConfig's own /auth/config fetch — not under test here, just needs to resolve.
  get.mockImplementation((url: string) => {
    if (url === '/auth/config') return Promise.resolve({ data: { domain: { scheme: 'http', workspaceBaseDomain: null } } });
    throw new Error(`unexpected GET ${url}`);
  });
});

async function fillForm(name: string, subdomain: string) {
  if (name) fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: name } });
  if (subdomain) fireEvent.change(screen.getByLabelText('Workspace address'), { target: { value: subdomain } });
}

describe('validation — empty submit never does nothing silently', () => {
  it('shows both required-field errors and focuses the name field first', async () => {
    mountAt();
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Workspace name is required.')).toBeInTheDocument();
    expect(screen.getByText('Please enter a subdomain.')).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace name')).toHaveFocus();
    expect(post).not.toHaveBeenCalled();
  });

  it('name filled, subdomain empty — only the subdomain error shows, and it gets focus', async () => {
    mountAt();
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Issac Recruitment' } });
    // Typing a name auto-fills the subdomain unless manually edited — clear it back out.
    fireEvent.change(screen.getByLabelText('Workspace address'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Please enter a subdomain.')).toBeInTheDocument();
    expect(screen.queryByText('Workspace name is required.')).toBeNull();
    expect(screen.getByLabelText('Workspace address')).toHaveFocus();
  });

  it('an invalid (too-short) subdomain shows a distinct message from "empty"', async () => {
    mountAt();
    await fillForm('Issac Recruitment', 'ab');
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Enter a valid subdomain.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('clears the field error the moment the field becomes valid, without a resubmit', async () => {
    mountAt();
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Workspace name is required.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Issac Recruitment' } });
    expect(screen.queryByText('Workspace name is required.')).toBeNull();
  });
});

describe('subdomain availability', () => {
  it('a reserved subdomain is rejected with its own message', async () => {
    post.mockImplementation((url: string) => {
      if (url === '/manager-workspaces/subdomain/check') return Promise.resolve({ data: reservedCheck('admin') });
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'admin');
    await screen.findByText(/cannot be used/);
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('This subdomain cannot be used.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalledWith('/manager-workspaces', expect.anything());
  });

  it('a taken subdomain is rejected with its own message', async () => {
    post.mockImplementation((url: string) => {
      if (url === '/manager-workspaces/subdomain/check') return Promise.resolve({ data: takenCheck('issac') });
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    await screen.findByText(/already taken/);
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('This subdomain is already taken.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalledWith('/manager-workspaces', expect.anything());
  });

  it('an availability check network failure shows an explicit error, not silence', async () => {
    post.mockImplementation((url: string) => {
      if (url === '/manager-workspaces/subdomain/check') return Promise.reject(new Error('network down'));
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    await screen.findByText("Couldn't check availability. Please try again.");
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText("Couldn't check availability. Please try again.")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalledWith('/manager-workspaces', expect.anything());
  });

  it('submitting while the check is still pending waits for the real result instead of guessing', async () => {
    let resolveCheck: (v: { data: unknown }) => void;
    const pending = new Promise((resolve) => { resolveCheck = resolve; });
    post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/manager-workspaces/subdomain/check') return pending;
      if (url === '/manager-workspaces') return Promise.resolve({ data: { id: 'ws-1', name: (body as any).name, subdomain: (body as any).subdomain } });
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    // Click immediately — the debounced check is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    // Must not have created the workspace yet — availability isn't established.
    await new Promise((r) => setTimeout(r, 50));
    expect(post).not.toHaveBeenCalledWith('/manager-workspaces', expect.anything());

    resolveCheck!({ data: availableCheck('issac') });
    await waitFor(() => expect(screen.getByText('PROFILE')).toBeInTheDocument());
  });

  it('stale (superseded) availability responses never overwrite a newer one', async () => {
    let resolveFirst: (v: { data: unknown }) => void;
    const firstPending = new Promise((resolve) => { resolveFirst = resolve; });
    post.mockImplementation((url: string, body?: { candidate: string }) => {
      if (url === '/manager-workspaces/subdomain/check') {
        if (body?.candidate === 'issac') return firstPending;
        if (body?.candidate === 'issacteam') return Promise.resolve({ data: takenCheck('issacteam') });
      }
      throw new Error(`unexpected POST ${url} ${JSON.stringify(body)}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    // Change the value again before the first check resolves — a newer check for "issacteam" starts.
    fireEvent.change(screen.getByLabelText('Workspace address'), { target: { value: 'issacteam' } });
    await screen.findByText(/already taken/);
    // The first (slow) request now resolves — it must be discarded, not overwrite the newer result.
    resolveFirst!({ data: availableCheck('issac') });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/already taken/)).toBeInTheDocument();
  });
});

describe('successful submission and backend errors', () => {
  it('a fully valid submission navigates to the profile step', async () => {
    post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/manager-workspaces/subdomain/check') return Promise.resolve({ data: availableCheck('issac') });
      if (url === '/manager-workspaces') return Promise.resolve({ data: { id: 'ws-1', name: (body as any).name, subdomain: (body as any).subdomain } });
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    await screen.findByText(/is available/);
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(screen.getByText('PROFILE')).toBeInTheDocument());
  });

  it('a backend creation failure (5xx) shows the safe generic error and stays on the form', async () => {
    post.mockImplementation((url: string) => {
      if (url === '/manager-workspaces/subdomain/check') return Promise.resolve({ data: availableCheck('issac') });
      if (url === '/manager-workspaces') {
        const err: any = new Error('fail');
        err.response = { status: 500, data: { message: 'Workspace creation is temporarily unavailable.' } };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    await screen.findByText(/is available/);
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    // 5xx: the shared normaliser shows the safe generic text (owner rule), never the server body.
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('PROFILE')).toBeNull();
  });

  it('Enter-key submission runs the same validation as a click', async () => {
    mountAt();
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: '' } });
    const form = screen.getByLabelText('Workspace name').closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText('Workspace name is required.')).toBeInTheDocument();
  });

  it('prevents a duplicate submission while the request is already in flight', async () => {
    let resolveCreate: (v: { data: unknown }) => void;
    const pendingCreate = new Promise((resolve) => { resolveCreate = resolve; });
    post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/manager-workspaces/subdomain/check') return Promise.resolve({ data: availableCheck('issac') });
      if (url === '/manager-workspaces') return pendingCreate;
      throw new Error(`unexpected POST ${url}`);
    });
    mountAt();
    await fillForm('Issac Recruitment', 'issac');
    await screen.findByText(/is available/);
    const button = screen.getByRole('button', { name: 'Create workspace' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button); // second click while disabled/in-flight — must not fire a second POST
    resolveCreate!({ data: { id: 'ws-1', name: 'Issac Recruitment', subdomain: 'issac' } });
    await waitFor(() => expect(screen.getByText('PROFILE')).toBeInTheDocument());
    expect(post.mock.calls.filter(([u]) => u === '/manager-workspaces')).toHaveLength(1);
  });
});
