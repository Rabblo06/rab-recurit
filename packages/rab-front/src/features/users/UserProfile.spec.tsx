import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

import { api } from '../../shared/api';
import UserProfile from './UserProfile';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock };

const users: Record<string, { id: string; fullName: string; email: string; username: string }> = {
  'user-a': { id: 'user-a', fullName: 'Alex Able', email: 'alex@example.test', username: 'alex' },
  'user-b': { id: 'user-b', fullName: 'Blair Baker', email: 'blair@example.test', username: 'blair' },
};

function GoTo({ to }: { to: string }) {
  const nav = useNavigate();
  return <button type="button" onClick={() => nav(to)}>go {to}</button>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <GoTo to="/users/user-b" />
        <Routes>
          <Route path="/users/:id" element={<UserProfile />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function addNote(text: string) {
  await userEvent.click(await screen.findByRole('button', { name: /Notes/ }));
  await userEvent.click(screen.getByRole('button', { name: /New note/ }));
  await userEvent.type(screen.getByPlaceholderText('Write a note…'), text);
  await userEvent.click(screen.getByRole('button', { name: /Add note/ }));
}

/**
 * CF-23: staff notes on the user profile page were persisted to localStorage under
 * `user-notes-<id>`, so they outlived the session and were readable by the next account
 * on a shared device. Notes now live in component memory only.
 */
describe('UserProfile notes (CF-23)', () => {
  let setItem: jest.SpyInstance;
  let sessionSetItem: jest.SpyInstance;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockApi.get.mockImplementation(async (url: string) => {
      const id = url.match(/^\/users\/(.+)$/)?.[1];
      if (id) return { data: users[id] };
      if (url === '/audit-logs') return { data: { items: [] } };
      throw new Error(`unexpected GET ${url}`);
    });
    setItem = jest.spyOn(Storage.prototype, 'setItem');
    sessionSetItem = jest.spyOn(window.sessionStorage, 'setItem');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a note it added, but writes nothing to localStorage or sessionStorage', async () => {
    renderAt('/users/user-a');
    await addNote('Prefers late shifts; medical note on file');

    expect(await screen.findByText('Prefers late shifts; medical note on file')).toBeTruthy();
    expect(screen.getByText(/Notes on this page are not saved/)).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('never reads back or keeps notes persisted by an older build, and purges them on mount', async () => {
    localStorage.setItem('user-notes-user-a', JSON.stringify([{ id: 'n1', text: 'Leaked note', createdAt: new Date().toISOString() }]));
    localStorage.setItem('user-notes-someone-else', JSON.stringify([{ id: 'n2', text: 'Other leaked note', createdAt: new Date().toISOString() }]));
    localStorage.setItem('unrelated-key', 'kept');
    setItem.mockClear();

    renderAt('/users/user-a');
    await userEvent.click(await screen.findByRole('button', { name: /Notes/ }));

    expect(screen.queryByText('Leaked note')).toBeNull();
    expect(screen.getByText('No notes')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem('user-notes-user-a')).toBeNull());
    expect(localStorage.getItem('user-notes-someone-else')).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('kept');
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not show one person's in-memory notes on another person's page", async () => {
    renderAt('/users/user-a');
    await addNote('Only about Alex');
    expect(await screen.findByText('Only about Alex')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'go /users/user-b' }));
    expect(await screen.findByText('Blair Baker', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText('Only about Alex')).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });
});
