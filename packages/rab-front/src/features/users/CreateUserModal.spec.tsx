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
// relies on.
jest.mock('./PhoneInput', () => ({
  __esModule: true,
  default: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input
      aria-label="Mobile number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? 'Enter phone number'}
    />
  ),
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock };

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

async function fillPersonalStep() {
  await screen.findByText('Step 1 of 5');
  await userEvent.type(screen.getByLabelText(/First name/), 'Jordan');
  await userEvent.type(screen.getByLabelText(/Last name/), 'QA');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 2 of 5');
  // The suggested staff reference auto-fills from the mocked
  // `/staff/next-reference` call — Employment can't advance without it.
  await waitFor(() => expect((screen.getByPlaceholderText('staff1') as HTMLInputElement).value).not.toBe(''));
}

/** Assumes the wizard is currently on Employment (Step 2) — advances into General and fills it. */
async function fillGeneralStep() {
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 3 of 5');
  await userEvent.type(screen.getByLabelText(/^Email/), 'jordan.qa@example.com');
  await userEvent.type(screen.getByLabelText('Mobile number'), '+447700900000');
  await userEvent.click(screen.getByRole('button', { name: 'Generate password' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 4 of 5');
}

async function fillEmergencyStep() {
  await userEvent.type(screen.getByLabelText(/Full name/), 'Jane Doe');
  await userEvent.type(screen.getByLabelText(/Relationship/), 'Spouse');
  await userEvent.type(screen.getByLabelText(/^Phone number/), '+447700900001');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Step 5 of 5');
}

beforeEach(() => {
  Object.values(mockApi).forEach((m) => m.mockReset());
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/job-roles') return Promise.resolve({ data: [{ id: 'role-1', name: 'Bartender' }] });
    if (url === '/staff/next-reference') return Promise.resolve({ data: { staffRef: 'staff1' } });
    return Promise.resolve({ data: [] });
  });
});

describe('New Staff wizard — stage removal (Part 4/11, TEST 16/17)', () => {
  it('has exactly 5 stages, in order, and never renders the removed Work Information / Right to Work / Additional stages', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('Employment');

    await fillGeneralStep(); // -> Emergency Contact (Step 4 of 5)
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('Emergency Contact');

    await fillEmergencyStep(); // -> Availability (Step 5 of 5, the last)
    expect(document.querySelector('.wizard-step-title')?.textContent).toBe('Availability');

    expect(screen.queryByText(/of 8/)).toBeNull();
    expect(screen.queryByText(/of 6/)).toBeNull();
    expect(screen.queryByText('Work Information')).toBeNull();
    expect(screen.queryByText('Right to Work')).toBeNull();
    expect(screen.queryByText('Additional')).toBeNull();
    // The last stage really is Availability — no Next button beyond it.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('removed the "Status will be Pending..." sentence from the Employment stage', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();
    expect(screen.queryByText(/Status will be Pending until the invitation is accepted/)).toBeNull();
  });
});

describe('New Staff wizard — Job role (Part 5A, TEST 10/11/12)', () => {
  // TEST 10
  it('the Job role select offers None, predefined roles, and Custom role — with no decorative dashes', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();

    const select = await screen.findByLabelText('Job role') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['None', 'Bartender', 'Custom role']);
  });

  // TEST 11
  it('shows a "Custom job role" text input only once Custom role is selected', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();

    expect(screen.queryByLabelText(/Custom job role/)).toBeNull();
    await userEvent.selectOptions(await screen.findByLabelText('Job role'), 'Custom role');
    expect(await screen.findByLabelText(/Custom job role/)).toBeTruthy();
  });

  // TEST 12
  it('a typed custom role survives Next then Back', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();

    await userEvent.selectOptions(await screen.findByLabelText('Job role'), 'Custom role');
    await userEvent.type(await screen.findByLabelText(/Custom job role/), 'Banqueting Supervisor');

    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> General
    await screen.findByText('Step 3 of 5');
    await userEvent.click(screen.getByRole('button', { name: 'Back' })); // -> back to Employment
    await screen.findByText('Step 2 of 5');

    expect((await screen.findByLabelText('Job role') as HTMLSelectElement).value).toBe('__custom_job_role__');
    expect((await screen.findByLabelText(/Custom job role/) as HTMLInputElement).value).toBe('Banqueting Supervisor');
  });
});

describe('New Staff wizard — Employment type (Part 5B)', () => {
  it('has no decorative dashes in the Employment type placeholder', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();
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
    await fillPersonalStep();
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // -> General
    await screen.findByText('Step 3 of 5');

    await userEvent.type(screen.getByLabelText(/^Email/), 'foo@bar');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('Please enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Step 3 of 5')).toBeTruthy(); // did not advance
  });

  it('allows Next once the email is valid and the rest of the step is filled', async () => {
    mount();
    openCreateStaff();
    await fillPersonalStep();
    await fillGeneralStep();
    expect(screen.getByText('Step 4 of 5')).toBeTruthy();
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
      staffRef: 'staff1',
    })));
    // Removed-stage fields were never sent.
    const body = mockApi.post.mock.calls.find((c) => c[0] === '/staff')![1];
    expect(body).not.toHaveProperty('otherSkills');
    expect(body).not.toHaveProperty('yearsExperience');
    expect(body).not.toHaveProperty('rightToWorkStatus');
    expect(body).not.toHaveProperty('documentType');
    expect(body).not.toHaveProperty('expiryDate');
    expect(body).not.toHaveProperty('languages');
    expect(body).not.toHaveProperty('notes');
  });
});
