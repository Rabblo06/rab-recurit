import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import CreateUserModal from './CreateUserModal';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

// `react-phone-number-input`'s own masking/parsing behaviour is not this
// component's concern to test — a plain controlled input keeps these tests
// focused on the wizard's own step/validation/state logic, matching how
// `value`/`onChange` (E.164 in, E.164 out) are the only contract this file
// relies on. No hardcoded `aria-label` — both the Mobile number field and the
// Emergency Contact phone field now render this same component, so the real
// accessible name must come from `FormField`'s own `<label htmlFor>`
// association (via the `id` it auto-clones onto this element), exactly as it
// would in the real app, or the two fields become indistinguishable to
// `getByLabelText`.
jest.mock('./PhoneInput', () => ({
  __esModule: true,
  default: ({ value, onChange, placeholder, id }: { value: string; onChange: (v: string) => void; placeholder?: string; id?: string }) => (
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? 'Enter phone number'}
    />
  ),
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock };

// jsdom has no real `URL.createObjectURL`/`revokeObjectURL` implementation
// (confirmed: `typeof URL.createObjectURL` is `undefined` here) — the
// avatar preview's own `useEffect` would throw the moment a file is picked
// without this. A real browser always has both; this is a test-environment
// gap only.
beforeAll(() => {
  (URL as any).createObjectURL = jest.fn(() => 'blob:mock-preview-url');
  (URL as any).revokeObjectURL = jest.fn();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateUserModal />
    </QueryClientProvider>,
  );
}

const openCreateStaff = () => act(() => {
  document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'staff' } }));
});

/** Personal Details now also contains the former Employment fields (merged step) — this fills only the required name fields and advances, leaving Employment's optional fields untouched. */
async function fillPersonalStep() {
  await screen.findByText('Step 1 of 4');
  await userEvent.type(screen.getByLabelText(/First name/), 'Jordan');
  await userEvent.type(screen.getByLabelText(/Last name/), 'QA');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 2 of 4');
}

/** Assumes the wizard is currently on General (Step 2) — fills it and advances to Emergency Contact. */
async function fillGeneralStep() {
  await userEvent.type(screen.getByLabelText(/^Email/), 'jordan.qa@example.com');
  await userEvent.type(screen.getByLabelText(/^Mobile number/), '+447700900000');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 3 of 4');
}

async function fillEmergencyStep() {
  await userEvent.type(screen.getByLabelText(/Full name/), 'Jane Doe');
  await userEvent.type(screen.getByLabelText(/Relationship/), 'Spouse');
  await userEvent.type(screen.getByLabelText(/^Phone number/), '+447700900001');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 4 of 4');
}

beforeEach(() => {
  Object.values(mockApi).forEach((m) => m.mockReset());
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/job-roles') return Promise.resolve({ data: [{ id: 'role-1', name: 'Bartender' }] });
    return Promise.resolve({ data: [] });
  });
});

describe('New Staff wizard — stage merge & removal (Part 1, Part 4/11, TEST 16/17)', () => {
  it('has exactly 4 stages, Personal Details absorbing the former Employment stage, and never renders the removed Work Information / Right to Work / Additional stages', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('Personal Details');
    // Employment's fields (Job role, Employment type, Start date, Default
    // rate) render inside this same first step, under an in-page divider —
    // not as a second top-level step titled "Employment".
    expect(screen.getByLabelText('Job role')).toBeTruthy();
    expect(screen.getByLabelText('Employment type')).toBeTruthy();
    expect(screen.getByText('Employment')).toBeTruthy();

    await fillPersonalStep();
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('General');

    await fillGeneralStep(); // -> Emergency Contact (Step 3 of 4)
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('Emergency Contact');

    await fillEmergencyStep(); // -> Availability (Step 4 of 4, the last)
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('Availability');

    expect(screen.queryByText(/of 8/)).toBeNull();
    expect(screen.queryByText(/of 6/)).toBeNull();
    expect(screen.queryByText(/of 5/)).toBeNull();
    expect(screen.queryByText('Work Information')).toBeNull();
    expect(screen.queryByText('Right to Work')).toBeNull();
    expect(screen.queryByText('Additional')).toBeNull();
    // The last stage really is Availability — no Next button beyond it.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('removed the "Status will be Pending..." sentence from the merged Personal Details/Employment stage', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    expect(screen.queryByText(/Status will be Pending until the invitation is accepted/)).toBeNull();
  });
});

describe('New Staff wizard — Job role (Part 5A, TEST 10/11/12)', () => {
  // TEST 10 — Job role now lives on the merged Personal Details/Employment
  // step, visible immediately (no Next required to reach it).
  it('the Job role select offers None, predefined roles, and Custom role — with no decorative dashes', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');

    const select = await screen.findByLabelText('Job role') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['None', 'Bartender', 'Custom role']);
  });

  // TEST 11
  it('shows a "Custom job role" text input only once Custom role is selected', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');

    expect(screen.queryByLabelText(/Custom job role/)).toBeNull();
    await userEvent.selectOptions(await screen.findByLabelText('Job role'), 'Custom role');
    expect(await screen.findByLabelText(/Custom job role/)).toBeTruthy();
  });

  // TEST 12
  it('a typed custom role survives Next then Back', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    await userEvent.type(screen.getByLabelText(/First name/), 'Jordan');
    await userEvent.type(screen.getByLabelText(/Last name/), 'QA');

    await userEvent.selectOptions(await screen.findByLabelText('Job role'), 'Custom role');
    await userEvent.type(await screen.findByLabelText(/Custom job role/), 'Banqueting Supervisor');

    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> General
    await screen.findByText('Step 2 of 4');
    await userEvent.click(screen.getByRole('button', { name: 'Back' })); // -> back to Personal Details/Employment
    await screen.findByText('Step 1 of 4');

    expect((await screen.findByLabelText('Job role') as HTMLSelectElement).value).toBe('__custom_job_role__');
    expect((await screen.findByLabelText(/Custom job role/) as HTMLInputElement).value).toBe('Banqueting Supervisor');
  });
});

describe('New Staff wizard — Employment type (Part 5B)', () => {
  it('has no decorative dashes in the Employment type placeholder', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    const select = await screen.findByLabelText('Employment type') as HTMLSelectElement;
    expect(within(select).getAllByRole('option')[0]!.textContent).toBe('Select employment type');
  });
});

describe('Availability stage (Part 8A)', () => {
  it('has no decorative dashes in the Preferred shift times placeholder', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();
    await fillGeneralStep();
    await fillEmergencyStep();
    const select = screen.getByLabelText('Preferred shift times') as HTMLSelectElement;
    expect(within(select).getAllByRole('option')[0]!.textContent).toBe('Select preferred shift time');
  });
});

describe('New Staff wizard — email validation (Part 6A, TEST 13/14)', () => {
  it('blocks Next on an invalid email and shows the error', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep(); // -> General (Step 2 of 4)
    await screen.findByText('Step 2 of 4');

    await userEvent.type(screen.getByLabelText(/^Email/), 'foo@bar');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('Please enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy(); // did not advance
  });

  it('allows Next once the email is valid and the rest of the step is filled', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();
    await fillGeneralStep();
    expect(screen.getByText('Step 3 of 4')).toBeTruthy();
  });
});

describe('New Staff wizard — full creation flow (TEST 19/20)', () => {
  it('creates staff successfully once every stage is filled', async () => {
    mockApi.post.mockResolvedValue({ data: { id: 'staff-99', invite: { sendNumber: 1, queued: true } } });
    mount();
    openCreateStaff();
    await fillPersonalStep();
    await fillGeneralStep();
    await fillEmergencyStep();

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/staff', expect.objectContaining({
      email: 'jordan.qa@example.com',
      firstName: 'Jordan',
      lastName: 'QA',
    })));
    // Removed-stage fields were never sent, and neither were the
    // now-server-generated Staff Reference or the removed Temporary
    // Password field — the server is the only generator of both.
    const body = mockApi.post.mock.calls.find((c) => c[0] === '/staff')![1];
    expect(body).not.toHaveProperty('staffRef');
    expect(body).not.toHaveProperty('temporaryPassword');
    expect(body).not.toHaveProperty('otherSkills');
    expect(body).not.toHaveProperty('yearsExperience');
    expect(body).not.toHaveProperty('rightToWorkStatus');
    expect(body).not.toHaveProperty('documentType');
    expect(body).not.toHaveProperty('expiryDate');
    expect(body).not.toHaveProperty('languages');
    expect(body).not.toHaveProperty('notes');
  });
});

describe('New Staff wizard — avatar (Part 3/4)', () => {
  function pngFile(name = 'avatar.png') {
    return new File([new Uint8Array(10)], name, { type: 'image/png' });
  }

  it('is clickable from the very first step and holds the picked file as a local preview only — no network call yet', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');

    expect(screen.getByRole('button', { name: 'Change photo' })).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, pngFile());

    // Nothing uploaded during the wizard — only on successful creation.
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('on successful creation, follows up with POST /staff/:id/avatar carrying the picked file', async () => {
    mockApi.post.mockImplementation((url: string) => {
      if (url === '/staff') return Promise.resolve({ data: { id: 'staff-avatar-1', invite: { sendNumber: 1, queued: true } } });
      return Promise.resolve({ data: { avatarKey: 'file-1' } });
    });
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = pngFile();
    await userEvent.upload(input, file);

    await fillPersonalStep();
    await fillGeneralStep();
    await fillEmergencyStep();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(
      '/staff/staff-avatar-1/avatar',
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'multipart/form-data' }) }),
    ));
    const avatarCall = mockApi.post.mock.calls.find((c) => c[0] === '/staff/staff-avatar-1/avatar')!;
    expect(avatarCall[1]).toBeInstanceOf(FormData);
    expect((avatarCall[1] as FormData).get('file')).toBe(file);
  });

  it('a creation-blocking failure never uploads the picked avatar — nothing to orphan if the record is never created', async () => {
    mockApi.post.mockRejectedValue({ response: { data: { message: 'A user with this email already exists.' } } });
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, pngFile());

    await fillPersonalStep();
    await fillGeneralStep();
    await fillEmergencyStep();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith('/staff', expect.anything());
  });

  it('cancelling the panel after picking a file never uploads it', async () => {
    mount();
    openCreateStaff();
    await screen.findByText('Step 1 of 4');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, pngFile());

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
