import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import { markAuthenticated, markUnauthenticated } from '../../../shared/lib/auth-session';
import { toast } from '../../../shared/lib/toast';
import { signInAgain } from '../../../shared/lib/mutationFeedback';
import ToastHost from '../../../shell/ToastHost';
import ProfilePage from './ProfilePage';
import { clearProfileDraft } from './profile-draft';

/**
 * Settings → Profile user feedback, end to end through the REAL ProfilePage, AvatarUpload, DevicesList and ToastHost.
 * Only `shared/api` is mocked (its `import.meta.env` does not parse under the CommonJS spec build), and every mocked
 * response uses the real server shapes:
 *  - success bodies: ProfileService.toProfileResponse `{ id, email, firstName, lastName, jobTitle, avatarKey }`;
 *  - errors: axios-shaped `{ response: { status, data } }` with Nest's bodies — ValidationPipe 400
 *    `{ statusCode, message: string[], error }`, Multer 413 "File too large", FileService's 400 sniff text, the
 *    AllExceptionsFilter 500 `{ statusCode: 500, message: 'Internal server error' }`, and a no-response network error.
 */
jest.mock('../../../shared/api', () => ({
  api: { get: jest.fn(), patch: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

jest.mock('framer-motion', () => {
  const React = require('react');
  const cache: Record<string, unknown> = {};
  const passthrough = (tag: string) =>
    (cache[tag] ??= React.forwardRef(({ children, variants, initial, animate, exit, transition, layout, layoutId, ...rest }: any, ref: any) =>
      React.createElement(tag, { ...rest, ref }, children)));
  return {
    __esModule: true,
    motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: jest.fn(() => false),
  };
});

const mockApi = api as unknown as { get: jest.Mock; patch: jest.Mock; post: jest.Mock; delete: jest.Mock };

const PROFILE = { id: 'user-1', email: 'jordan.hale@example.test', firstName: 'Jordan', lastName: 'Hale', jobTitle: 'Operations manager', avatarKey: null as string | null };
const MB = 1024 * 1024;

function httpError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });
}
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', response: undefined });
const NEST_500 = { statusCode: 500, message: 'Internal server error' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeJwt(sub: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ sub, sid: `sid-${sub}` })}.`;
}

/** The fake server's current profile: what GET /profile returns, and what a confirmed write changes (`confirm`). */
const server = { profile: PROFILE };
/** Resolves a pending write the way the real server does: the row changes, then the response carries it. */
async function confirm(pending: { resolve: (v: { data: unknown }) => void }, profile: typeof PROFILE) {
  server.profile = profile;
  await act(async () => pending.resolve({ data: profile }));
}

function setup(profile = PROFILE, sessions: unknown[] | null = null) {
  server.profile = profile;
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/profile') return Promise.resolve({ data: server.profile });
    if (url === '/profile/sessions' && sessions) return Promise.resolve({ data: sessions });
    return new Promise(() => {}); // avatar bytes, devices: never resolve unless asked
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProfilePage />
        <ToastHost />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const firstName = () => screen.getByLabelText('First name') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /Save changes|Saving…/ });
const fileInput = () => screen.getByLabelText('Choose a profile photo') as HTMLInputElement;
function pick(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}
function png(name = 'me.png', size?: number) {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type: 'image/png' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.patch.mockReset();
  mockApi.post.mockReset();
  mockApi.delete.mockReset();
  clearProfileDraft();
  markUnauthenticated();
  markAuthenticated(fakeJwt('user-1'));
});
afterEach(() => {
  act(() => toast.dismiss());
});

describe('Profile save', () => {
  it('1: success — one PATCH with the typed values, success toast only after the server answers, form updated from the response', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    const pending = deferred<{ data: unknown }>();
    mockApi.patch.mockReturnValue(pending.promise);

    fireEvent.change(firstName(), { target: { value: 'Jordana' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/profile', { firstName: 'Jordana', lastName: 'Hale', jobTitle: 'Operations manager' }));
    expect(saveButton()).toHaveTextContent('Saving…');
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByText('Profile updated.')).toBeNull(); // nothing claimed before the server answers

    await confirm(pending, { ...PROFILE, firstName: 'Jordana' });
    const status = await screen.findByText('Profile updated.');
    expect(status.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    expect(firstName().value).toBe('Jordana');
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save changes'));
  });

  it('2 + 11: a server failure keeps every typed value and shows a red error with "Try again"', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    mockApi.patch.mockRejectedValueOnce(httpError(500, NEST_500));

    fireEvent.change(firstName(), { target: { value: 'Unsaved edit' } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Rota lead' } });
    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save your profile. Please try again.');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).not.toHaveTextContent(/Internal server error/);
    expect(firstName().value).toBe('Unsaved edit');
    expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('Rota lead');
    expect(saveButton()).toBeEnabled();

    // The next action re-sends the same values.
    mockApi.patch.mockImplementationOnce(async () => {
      server.profile = { ...PROFILE, firstName: 'Unsaved edit', jobTitle: 'Rota lead' };
      return { data: server.profile };
    });
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(2));
    expect(mockApi.patch).toHaveBeenLastCalledWith('/profile', { firstName: 'Unsaved edit', lastName: 'Hale', jobTitle: 'Rota lead' });
    expect(await screen.findByText('Profile updated.')).toBeInTheDocument();
  });

  it('11: a server validation error is shown under its field (never the raw class-validator text) and the input is kept', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    mockApi.patch.mockRejectedValueOnce(httpError(400, { statusCode: 400, message: ['jobTitle must be a string'], error: 'Bad Request' }));

    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Lead' } });
    fireEvent.click(saveButton());

    const job = screen.getByLabelText('Job title');
    await waitFor(() => expect(job).toHaveAttribute('aria-invalid', 'true'));
    expect(job).toHaveAccessibleDescription('Enter a valid job title.');
    expect(job).toHaveFocus();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your profile was not saved. Check the highlighted fields.');
    expect(screen.queryByText(/must be a string/)).toBeNull();
    expect((job as HTMLInputElement).value).toBe('Lead');

    // Editing the field clears its error.
    fireEvent.change(job, { target: { value: 'Lead 2' } });
    expect(job).not.toHaveAttribute('aria-invalid');
  });

  it('invalid input: an empty first name is caught before any request, under the field', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    fireEvent.change(firstName(), { target: { value: '' } });
    fireEvent.click(saveButton());
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(firstName()).toHaveAttribute('aria-invalid', 'true');
    expect(firstName()).toHaveAccessibleDescription('Enter your first name.');
    expect(firstName()).toHaveFocus();
  });

  it('8: duplicate submission — two submits before the first answer send exactly one request', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    const pending = deferred<{ data: unknown }>();
    mockApi.patch.mockReturnValue(pending.promise);
    fireEvent.change(firstName(), { target: { value: 'Once' } });
    const form = firstName().closest('form')!;
    // Submitting the form directly bypasses the disabled button: only the in-flight guard can stop the second one.
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await confirm(pending, { ...PROFILE, firstName: 'Once' });
    await screen.findByText('Profile updated.');
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
  });

  it('9: an expired session (401) says so, stays until dismissed, and offers "Sign in again"', async () => {
    const go = jest.spyOn(signInAgain, 'go').mockImplementation(() => {});
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    mockApi.patch.mockRejectedValueOnce(httpError(401, { statusCode: 401, message: 'Invalid session.' }));
    fireEvent.change(firstName(), { target: { value: 'Kept' } });
    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your session has expired. Please sign in again.');
    expect(alert).toHaveAttribute('data-persistent', 'true');
    expect(firstName().value).toBe('Kept');
    fireEvent.click(within(alert).getByRole('button', { name: 'Sign in again' }));
    expect(go).toHaveBeenCalledTimes(1);
    go.mockRestore();
  });

  it('10: a permission refusal (403) shows the safe server reason, or the standard text for a framework default', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    mockApi.patch
      .mockRejectedValueOnce(httpError(403, { statusCode: 403, message: 'Admin Inspect is read-only.', error: 'Forbidden' }))
      .mockRejectedValueOnce(httpError(403, { statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' }));
    fireEvent.change(firstName(), { target: { value: 'X' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText('Admin Inspect is read-only.')).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    expect(await screen.findByText("You don't have permission to perform this action.")).toBeInTheDocument();
    expect(screen.queryByText('Forbidden resource')).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0);
  });

  it('offline: a request with no response says the connection was lost and offers "Try again"', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    mockApi.patch.mockRejectedValueOnce(networkError());
    fireEvent.change(firstName(), { target: { value: 'Offline edit' } });
    fireEvent.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Connection lost. Check your internet connection.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(firstName().value).toBe('Offline edit');
  });
});

describe('Profile photo', () => {
  it('3 + 13: a valid photo shows real upload progress, then "Processing…" at 100 %, and success only after the server answers', async () => {
    setup();
    await screen.findByText('PNG, JPG or WebP · Maximum 10 MB');
    const pending = deferred<{ data: unknown }>();
    let config: { onUploadProgress?: (e: { loaded: number; total?: number }) => void; timeout?: number } = {};
    mockApi.post.mockImplementation((_url: string, _form: FormData, c: typeof config) => {
      config = c;
      return pending.promise;
    });

    pick(png());
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const [url, form] = mockApi.post.mock.calls[0];
    expect(url).toBe('/profile/avatar');
    expect((form as FormData).get('file')).toBeInstanceOf(File);
    expect(config.timeout).toBeGreaterThan(0);

    act(() => config.onUploadProgress!({ loaded: 42, total: 100 }));
    expect(screen.getByRole('button', { name: 'Uploading 42%…' })).toBeDisabled();
    expect(screen.getByText('Uploading photo…')).toHaveAttribute('aria-live', 'polite');

    act(() => config.onUploadProgress!({ loaded: 100, total: 100 }));
    expect(screen.getByRole('button', { name: 'Processing…' })).toBeDisabled();
    expect(screen.getByText('Upload complete. Saving your photo…')).toBeInTheDocument();
    expect(screen.queryByText('Profile photo updated.')).toBeNull(); // 100 % sent is not success

    await confirm(pending, { ...PROFILE, avatarKey: 'file-1' });
    expect(await screen.findByText('Profile photo updated.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Upload photo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument(); // the confirmed avatarKey is applied
  });

  it('4: an unsupported file type is refused before upload with the real accepted types and limit', async () => {
    setup();
    await screen.findByText('PNG, JPG or WebP · Maximum 10 MB');
    pick(new File(['GIF89a'], 'animation.gif', { type: 'image/gif' }));
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Upload failed. That file type isn't supported. Please choose a PNG, JPG or WebP image smaller than 10 MB.",
    );
  });

  it('5: a file over the server limit (10 MB) is refused before upload; a server 413 says the same', async () => {
    setup();
    await screen.findByText('PNG, JPG or WebP · Maximum 10 MB');
    pick(png('huge.png', 10 * MB + 1));
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Upload failed. That file is larger than 10 MB. Please choose a PNG, JPG or WebP image smaller than 10 MB.',
    );
    act(() => toast.dismiss());

    // Exactly 10 MB passes the client check; if the server still refuses it (e.g. a lower deployment cap) the 413 is explained.
    mockApi.post.mockRejectedValueOnce(httpError(413, { statusCode: 413, message: 'File too large', error: 'Payload Too Large' }));
    pick(png('edge.png', 10 * MB));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed. That file is larger than 10 MB.');
  });

  it("4b: the server's own byte-sniff rejection (a renamed file) is shown as the server wrote it", async () => {
    setup();
    await screen.findByText('PNG, JPG or WebP · Maximum 10 MB');
    mockApi.post.mockRejectedValueOnce(
      httpError(400, { statusCode: 400, message: 'Unsupported file type. Only PNG, JPG and WEBP images are accepted.', error: 'Bad Request' }),
    );
    pick(png('actually-a-pdf.png'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported file type. Only PNG, JPG and WEBP images are accepted.');
  });

  it('6: a storage failure (5xx) and a dropped connection are explained, nothing is claimed saved, and "Try again" re-sends the file', async () => {
    setup();
    await screen.findByText('PNG, JPG or WebP · Maximum 10 MB');
    mockApi.post.mockRejectedValueOnce(httpError(500, NEST_500)).mockRejectedValueOnce(networkError());
    pick(png());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Upload failed. Your photo could not be saved. Please try again.');
    expect(screen.queryByText('Profile photo updated.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeEnabled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Upload failed. Connection lost. Check your internet connection and try again.')).toBeInTheDocument();
  });

  it('8b: picking a second file while one is uploading does not start a second upload', async () => {
    setup();
    await screen.findByText('PNG, JPG or WebP · Maximum 10 MB');
    mockApi.post.mockReturnValue(new Promise(() => {}));
    pick(png('a.png'));
    pick(png('b.png'));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it('7: removing the photo asks first, shows progress, and confirms only after the server answers', async () => {
    setup({ ...PROFILE, avatarKey: 'file-1' });
    const pending = deferred<{ data: unknown }>();
    mockApi.delete.mockReturnValue(pending.promise);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove your profile photo?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/profile/avatar'));
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Please wait…' })).toBeDisabled();
    await confirm(pending, { ...PROFILE, avatarKey: null });
    expect(await screen.findByText('Profile photo removed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('7b: a failed removal says so and keeps the photo', async () => {
    setup({ ...PROFILE, avatarKey: 'file-1' });
    mockApi.delete.mockRejectedValueOnce(httpError(500, NEST_500));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove your profile photo. Please try again.');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });
});

describe('Password & access and Devices', () => {
  it('set password: success after the server accepts; a 429 explains the rate limit', async () => {
    setup();
    await waitFor(() => expect(firstName().value).toBe('Jordan'));
    mockApi.post.mockResolvedValueOnce({ data: undefined }).mockRejectedValueOnce(httpError(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'jordan.hale@example.test' }));
    expect(await screen.findByText('Check your email for a link to set a new password.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set password' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Too many requests. Please try again shortly.')).toBeInTheDocument();
    expect(screen.queryByText(/ThrottlerException/)).toBeNull();
  });

  it('devices: logging out another device shows progress on its row and a red error with "Try again" when the server fails', async () => {
    const now = new Date().toISOString();
    const row = (familyId: string, isCurrentDevice: boolean, userAgent: string | null = null) => ({ familyId, deviceId: null, userAgent, ip: null, ipScope: null, createdAt: now, lastActiveAt: now, isCurrentDevice });
    setup(PROFILE, [row('current', true), row('other', false, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')]);
    const pending = deferred<unknown>();
    mockApi.delete.mockReturnValueOnce(pending.promise);
    fireEvent.click(await screen.findByRole('button', { name: /^More options for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/profile/sessions/other'));
    expect(screen.getByText('Logging out…')).toBeInTheDocument();
    await act(async () => pending.reject(httpError(500, NEST_500)));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not log out this device. Please try again.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('devices: "Log out all other devices" reports how many the server ended', async () => {
    const now = new Date().toISOString();
    const row = (familyId: string, isCurrentDevice: boolean) => ({ familyId, deviceId: null, userAgent: null, ip: null, ipScope: null, createdAt: now, lastActiveAt: now, isCurrentDevice });
    setup(PROFILE, [row('current', true), row('a', false), row('b', false)]);
    mockApi.delete.mockResolvedValueOnce({ data: { revokedCount: 2 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Log out all other devices' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Log out other devices' }));
    expect(await screen.findByText('Logged out 2 other devices.')).toBeInTheDocument();
  });
});
