import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import StaffDocumentsSection, {
  type StaffDocumentView,
} from './StaffDocumentsSection';

jest.mock('../../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../../../shared/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const get = (api as unknown as { get: jest.Mock }).get;
const post = (api as unknown as { post: jest.Mock }).post;

const doc = (over: Partial<StaffDocumentView>): StaffDocumentView => ({
  id: 'd1',
  documentType: 'right_to_work',
  documentTypeLabel: 'Right to work',
  issuedOn: null,
  expiresOn: '2031-01-31',
  status: 'pending',
  scanStatus: 'clean',
  fileId: 'f1',
  uploadedAt: '2026-11-01T10:00:00Z',
  uploadedBySelf: false,
  verifiedAt: null,
  rejectionReason: null,
  revokedAt: null,
  revocationReason: null,
  expired: false,
  daysUntilExpiry: 400,
  ...over,
});

function mount(
  documents: StaffDocumentView[],
  requiredTypes: string[] = ['right_to_work'],
) {
  get.mockResolvedValue({ data: { documents, requiredTypes } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StaffDocumentsSection staffId="staff-1" staffName="Sam Staff" />
    </QueryClientProvider>,
  );
}

describe('StaffDocumentsSection', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it('lists documents from GET /staff/:id/documents and shows the required types', async () => {
    mount([doc({})]);
    expect(await screen.findByText('Right to work')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/staff/staff-1/documents');
    expect(screen.getByText(/Required: Right to work/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Download' }),
    ).toBeInTheDocument();
  });

  it('a not-yet-scanned file has no download and verify is disabled', async () => {
    mount([doc({ scanStatus: 'not_scanned', fileId: null })]);
    const item = await screen.findByTestId('staff-doc-d1');
    expect(within(item).queryByRole('button', { name: 'Download' })).toBeNull();
    expect(within(item).getByRole('button', { name: 'Verify' })).toBeDisabled();
    expect(within(item).getByText(/Awaiting virus scan/)).toBeInTheDocument();
  });

  it('an expired required document shows the offer block warning', async () => {
    mount([
      doc({ expired: true, expiresOn: '2020-01-31', daysUntilExpiry: -2000 }),
    ]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'New offers are blocked: Right to work expired',
    );
    expect(screen.getByText(/Expired 31 Jan 2020/)).toBeInTheDocument();
  });

  it('verify posts the named action, never a status field', async () => {
    post.mockResolvedValue({ data: {} });
    mount([doc({})]);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Verify' }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/staff/staff-1/documents/d1/verify',
        {},
      ),
    );
  });

  it('reject needs a reason of at least 3 characters', async () => {
    post.mockResolvedValue({ data: {} });
    mount([doc({})]);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reject' }),
    );
    const submit = screen.getByRole('button', { name: 'Reject document' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/unreadable/), 'Blurred');
    await userEvent.click(submit);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/staff/staff-1/documents/d1/reject', {
        reason: 'Blurred',
      }),
    );
  });

  it('refuses a wrong file type before uploading', async () => {
    mount([]);
    await screen.findByText('No documents yet.');
    const input = screen.getByLabelText('File') as HTMLInputElement;
    await userEvent.upload(
      input,
      new File(['GIF89a'], 'doc.gif', { type: 'image/gif' }),
      { applyAccept: false },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/file type/);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });
});
