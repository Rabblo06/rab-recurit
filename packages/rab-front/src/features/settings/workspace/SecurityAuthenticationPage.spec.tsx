import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SecurityAuthenticationPage from './SecurityAuthenticationPage';
import { api } from '../../../shared/api';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), patch: jest.fn() } }));
const get = api.get as jest.Mock;
const patch = api.patch as jest.Mock;

/** W6-E2E-04: the tenant sees its sign-in methods READ-ONLY; a platform administrator changes them. */
it('shows the organisation sign-in methods read-only, with no control that could change them', async () => {
  get.mockResolvedValue({
    data: {
      password: { organisationEnabled: false, systemEnabled: true },
      google: { organisationEnabled: true, systemEnabled: true },
      microsoft: { organisationEnabled: true, systemEnabled: false },
    },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><SecurityAuthenticationPage /></QueryClientProvider>);

  expect(await screen.findByText('Managed by your platform administrator. Contact them to change these settings.')).toBeInTheDocument();
  expect(screen.getByLabelText('Password sign-in off')).toBeInTheDocument();
  expect(screen.getByLabelText('Google sign-in on')).toBeInTheDocument();
  expect(screen.getByLabelText('Microsoft sign-in off')).toBeInTheDocument(); // unavailable on the deployment
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(get).toHaveBeenCalledWith('/workspace/security');
  expect(patch).not.toHaveBeenCalled();
});
