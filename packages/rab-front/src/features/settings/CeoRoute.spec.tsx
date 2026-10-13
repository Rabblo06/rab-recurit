import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CeoRoute from './CeoRoute';
import { api } from '../../shared/api';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn() } }));
const get = api.get as jest.Mock;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/workspace/team']}>
        <Routes>
          <Route path="/settings/workspace/team" element={<CeoRoute><div>TEAM PAGE</div></CeoRoute>} />
          <Route path="/settings/profile" element={<div>PROFILE PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => get.mockReset());

it('renders the page for a CEO', async () => {
  get.mockResolvedValue({ data: { roles: ['ceo'] } });
  mount();
  expect(await screen.findByText('TEAM PAGE')).toBeInTheDocument();
});

it('redirects a non-CEO away — the backend still enforces the real gate, this is UX only', async () => {
  get.mockResolvedValue({ data: { roles: ['manager'] } });
  mount();
  expect(await screen.findByText('PROFILE PAGE')).toBeInTheDocument();
  expect(screen.queryByText('TEAM PAGE')).toBeNull();
});
