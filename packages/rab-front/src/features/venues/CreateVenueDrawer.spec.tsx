import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import CreateVenueDrawer from './CreateVenueDrawer';
import { buildGeofencePayload, parseCoordinatePair, validateGeofence } from './venueGeofence';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock };

const savedVenue = {
  id: 'venue-1',
  name: 'The Grand Hotel',
  clientName: null,
  type: 'hotel',
  address: { line1: '1 Example Street', city: 'London', postcode: 'N1 1AA' },
  instructions: null,
  breakPaid: false,
  defaultBreakMinutes: null,
  lat: 51.5074,
  lng: -0.1278,
  geofenceRadiusM: 150,
  enforceGeofence: true,
  status: 'active',
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateVenueDrawer />
    </QueryClientProvider>,
  );
}

const openCreate = () => act(() => { document.dispatchEvent(new CustomEvent('open-create-venue')); });
const openEdit = (venue: object) => act(() => { document.dispatchEvent(new CustomEvent('open-edit-venue', { detail: { venue } })); });

const lat = () => screen.getByLabelText('Latitude') as HTMLInputElement;
const lng = () => screen.getByLabelText('Longitude') as HTMLInputElement;
const radius = () => screen.getByLabelText('Geofence radius') as HTMLInputElement;
const enforce = () => screen.getByRole('switch', { name: /Enforce geofence/ }) as HTMLInputElement;
const nameInput = () => document.querySelector('.field input') as HTMLInputElement;

async function typeInto(el: HTMLInputElement, value: string) {
  await userEvent.clear(el);
  if (value) await userEvent.type(el, value);
}

beforeEach(() => {
  Object.values(mockApi).forEach((m) => m.mockReset());
  mockApi.get.mockResolvedValue({ data: [] });
  mockApi.post.mockResolvedValue({ data: { ...savedVenue } });
  mockApi.patch.mockResolvedValue({ data: { ...savedVenue } });
});

describe('Create Venue drawer — Location & Geofence', () => {
  it('renders the Location & Geofence section with latitude, longitude, radius (metres) and the enforce switch, off by default', async () => {
    mount();
    openCreate();
    expect(await screen.findByText('Location & Geofence')).toBeTruthy();
    expect(lat().value).toBe('');
    expect(lng().value).toBe('');
    expect(radius().value).toBe('200'); // the server's existing default
    expect(screen.getByText('metres')).toBeTruthy();
    expect(enforce().checked).toBe(false);
    expect(screen.getByText(/Right-click the venue location in Google Maps/)).toBeTruthy();
  });

  it('shows a useful message for an invalid latitude and for an invalid longitude', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await typeInto(lat(), '91');
    expect(screen.getByText('Latitude must be between -90 and 90.')).toBeTruthy();
    await typeInto(lat(), '');
    await typeInto(lng(), '-181');
    expect(screen.getByText('Longitude must be between -180 and 180.')).toBeTruthy();
    await typeInto(lng(), 'NaN');
    expect(screen.getByText('Longitude must be between -180 and 180.')).toBeTruthy();
  });

  it('enforces the 50 metre radius minimum', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await typeInto(radius(), '49');
    expect(screen.getByText('Geofence radius must be at least 50 metres.')).toBeTruthy();
    await typeInto(radius(), '50');
    expect(screen.queryByText('Geofence radius must be at least 50 metres.')).toBeNull();
  });

  it('cannot submit with enforcement on and no location — shows why, and never calls the API', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await userEvent.type(nameInput(), 'Test venue');
    await userEvent.click(enforce());
    expect(screen.getByText('Set the venue location before enabling geofence enforcement.')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Create venue' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('cannot submit a half location (latitude without longitude)', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await userEvent.type(nameInput(), 'Test venue');
    await typeInto(lat(), '51.5');
    expect(screen.getByText('Enter the longitude as well.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create venue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits a valid enforced location with real numbers', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await userEvent.type(nameInput(), 'Test venue');
    await typeInto(lat(), '51.5074');
    await typeInto(lng(), '-0.1278');
    await typeInto(radius(), '100');
    await userEvent.click(enforce());
    const submit = screen.getByRole('button', { name: 'Create venue' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await userEvent.click(submit);
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/venues', expect.objectContaining({ lat: 51.5074, lng: -0.1278, geofenceRadiusM: 100, enforceGeofence: true })));
  });

  it('a venue with no location still creates normally with enforcement off (no coordinates sent)', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await userEvent.type(nameInput(), 'Plain venue');
    await userEvent.click(screen.getByRole('button', { name: 'Create venue' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0]![1];
    expect(body.enforceGeofence).toBe(false);
    expect(body.lat).toBeUndefined();
    expect(body.lng).toBeUndefined();
  });

  it('pasting "lat, lng" copied from Google Maps into Latitude fills both fields', async () => {
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    lat().focus();
    await userEvent.paste('51.5074, -0.1278');
    expect(lat().value).toBe('51.5074');
    expect(lng().value).toBe('-0.1278');
  });

  it('shows the server validation message when the backend rejects the save', async () => {
    mockApi.post.mockRejectedValue({ response: { data: { message: ['Set the venue latitude and longitude before enabling geofence enforcement.'] } } });
    mount();
    openCreate();
    await screen.findByText('Location & Geofence');
    await userEvent.type(nameInput(), 'Test venue');
    await userEvent.click(screen.getByRole('button', { name: 'Create venue' }));
    expect(await screen.findByText('Set the venue latitude and longitude before enabling geofence enforcement.')).toBeTruthy();
  });
});

describe('Edit Venue drawer — Location & Geofence', () => {
  it('populates the saved values (not defaults)', async () => {
    mount();
    openEdit(savedVenue);
    expect(await screen.findByText('Edit venue')).toBeTruthy();
    expect(lat().value).toBe('51.5074');
    expect(lng().value).toBe('-0.1278');
    expect(radius().value).toBe('150');
    expect(enforce().checked).toBe(true);
  });

  it('saves changed coordinates and radius via PATCH', async () => {
    mount();
    openEdit(savedVenue);
    await screen.findByText('Edit venue');
    await typeInto(lat(), '40.7128');
    await typeInto(lng(), '-74.006');
    await typeInto(radius(), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/venues/venue-1', expect.objectContaining({ lat: 40.7128, lng: -74.006, geofenceRadiusM: 250, enforceGeofence: true })),
    );
  });

  it('disabling enforcement saves enforceGeofence:false and keeps the location', async () => {
    mount();
    openEdit(savedVenue);
    await screen.findByText('Edit venue');
    await userEvent.click(enforce());
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch.mock.calls[0]![1]).toEqual(expect.objectContaining({ enforceGeofence: false, lat: 51.5074, lng: -0.1278 }));
  });

  it('clearing the location with enforcement off sends explicit nulls so it really clears; with enforcement on it cannot be submitted', async () => {
    mount();
    openEdit({ ...savedVenue, enforceGeofence: false });
    await screen.findByText('Edit venue');
    await typeInto(lat(), '');
    await typeInto(lng(), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch.mock.calls[0]![1]).toEqual(expect.objectContaining({ lat: null, lng: null, enforceGeofence: false }));
  });

  it('with enforcement on, clearing the location blocks Save', async () => {
    mount();
    openEdit(savedVenue);
    await screen.findByText('Edit venue');
    await typeInto(lat(), '');
    await typeInto(lng(), '');
    expect(screen.getByText('Set the venue location before enabling geofence enforcement.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reopening the drawer shows the persisted values, and a following Create starts from clean defaults', async () => {
    mount();
    openEdit(savedVenue);
    await screen.findByText('Edit venue');
    await typeInto(radius(), '300');
    mockApi.patch.mockResolvedValue({ data: { ...savedVenue, geofenceRadiusM: 300 } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByText('Edit venue')).toBeNull());

    // The list refetches and hands the drawer the persisted row again.
    openEdit({ ...savedVenue, geofenceRadiusM: 300 });
    await screen.findByText('Edit venue');
    expect(radius().value).toBe('300');
    expect(lat().value).toBe('51.5074');
    expect(enforce().checked).toBe(true);

    openCreate();
    await screen.findByRole('button', { name: 'Create venue' });
    expect(lat().value).toBe('');
    expect(radius().value).toBe('200');
    expect(enforce().checked).toBe(false);
  });
});

describe('Venue profile photo', () => {
  const photoInput = () => screen.getByLabelText('Venue profile photo file') as HTMLInputElement;
  const pick = (file: File) => fireEvent.change(photoInput(), { target: { files: [file] } });
  const png = (name = 'photo.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
  let toasts: Array<{ message: string; variant: string }>;
  const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);

  beforeAll(() => {
    (URL as any).createObjectURL = jest.fn(() => 'blob:venue-photo-preview');
    (URL as any).revokeObjectURL = jest.fn();
  });
  beforeEach(() => {
    toasts = [];
    document.addEventListener('toast', onToast);
  });
  afterEach(() => document.removeEventListener('toast', onToast));

  it('create mode shows the building placeholder, an "Upload photo" button and the format hint', async () => {
    mount();
    openCreate();
    expect(await screen.findByText('Venue profile photo')).toBeTruthy();
    expect(screen.getByTestId('venue-photo-placeholder')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeTruthy();
    expect(screen.getByText('JPG, PNG or WebP · Up to 5 MB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('rejects an unsupported type and a file over 5 MB on the client, staging nothing', async () => {
    mount();
    openCreate();
    await screen.findByText('Venue profile photo');
    pick(new File(['GIF89a'], 'anim.gif', { type: 'image/gif' }));
    expect(screen.getByText('Choose a JPG, PNG or WebP image.')).toBeTruthy();
    const big = png('big.png');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    pick(big);
    expect(screen.getByText('The photo must be 5 MB or smaller.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeTruthy();
    expect(screen.getByTestId('venue-photo-placeholder')).toBeTruthy();
  });

  it('create: previews the picked file locally, then uploads it to the new venue only after POST /venues succeeds', async () => {
    mount();
    openCreate();
    await screen.findByText('Venue profile photo');
    await userEvent.type(nameInput(), 'Photo venue');
    pick(png());
    const img = (await screen.findByAltText('Venue profile photo')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:venue-photo-preview');
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(mockApi.post).not.toHaveBeenCalled();

    mockApi.post.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/venues' ? { ...savedVenue, photoFileId: null } : { photoFileId: 'file-new' } }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create venue' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(mockApi.post.mock.calls[0]![0]).toBe('/venues');
    expect(mockApi.post.mock.calls[1]![0]).toBe('/venues/venue-1/photo');
    const body = mockApi.post.mock.calls[1]![1] as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('photo.png');
    expect(mockApi.post.mock.calls[0]![1]).not.toHaveProperty('photoFileId');
    expect(await screen.findByText('Edit venue')).toBeTruthy();
    expect(toasts.filter((t) => t.variant === 'error')).toEqual([]);
  });

  it('create: a failed photo upload (e.g. an API without the route) keeps the venue saved and shows an error toast', async () => {
    mount();
    openCreate();
    await screen.findByText('Venue profile photo');
    await userEvent.type(nameInput(), 'Photo venue');
    pick(png());
    mockApi.post.mockImplementation((url: string) =>
      url === '/venues'
        ? Promise.resolve({ data: { ...savedVenue } })
        : Promise.reject({ response: { status: 404, data: { message: 'Cannot POST /rest/v1/venues/venue-1/photo' } } }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create venue' }));
    expect(await screen.findByText('Edit venue')).toBeTruthy();
    await waitFor(() =>
      expect(toasts).toEqual([{ id: expect.any(Number), variant: 'error', message: 'Venue saved, but the photo could not be uploaded: please try again later.' }]),
    );
    expect(screen.queryByText('Could not save this venue. Please try again.')).toBeNull();
    // Still staged, so saving again retries the upload.
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
  });

  it("create: the server's 400 message is shown when it rejects the file", async () => {
    mount();
    openCreate();
    await screen.findByText('Venue profile photo');
    await userEvent.type(nameInput(), 'Photo venue');
    pick(png());
    mockApi.post.mockImplementation((url: string) =>
      url === '/venues'
        ? Promise.resolve({ data: { ...savedVenue } })
        : Promise.reject({ response: { status: 400, data: { message: 'Unsupported file type. Only PNG, JPG and WEBP images are accepted' } } }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create venue' }));
    await waitFor(() =>
      expect(toasts[0]?.message).toBe('Venue saved, but the photo could not be uploaded: Unsupported file type. Only PNG, JPG and WEBP images are accepted.'),
    );
  });

  it('edit: loads the saved photo with the authenticated blob fetch, and Remove + Save calls DELETE after the PATCH', async () => {
    mockApi.get.mockImplementation((url: string) => Promise.resolve({ data: url === '/files/file-1' ? new Blob(['x'], { type: 'image/png' }) : [] }));
    mount();
    openEdit({ ...savedVenue, photoFileId: 'file-1' });
    await screen.findByText('Edit venue');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/files/file-1', { responseType: 'blob' }));
    expect(await screen.findByAltText('Venue profile photo')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByTestId('venue-photo-placeholder')).toBeTruthy();
    mockApi.delete.mockResolvedValue({ data: { photoFileId: null } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/venues/venue-1/photo'));
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    expect(mockApi.patch.mock.invocationCallOrder[0]).toBeLessThan(mockApi.delete.mock.invocationCallOrder[0]!);
  });

  it('edit: Change + Save uploads the new file; nothing photo-related is sent when the photo was not touched', async () => {
    mount();
    openEdit({ ...savedVenue, photoFileId: null });
    await screen.findByText('Edit venue');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.delete).not.toHaveBeenCalled();

    openEdit({ ...savedVenue, photoFileId: 'file-1' });
    await screen.findByText('Edit venue');
    pick(png('new.png'));
    mockApi.post.mockResolvedValue({ data: { photoFileId: 'file-2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/venues/venue-1/photo', expect.any(FormData), expect.anything()));
  });

  it('a staged photo is discarded when the drawer is reopened (Cancel never uploads)', async () => {
    mount();
    openCreate();
    await screen.findByText('Venue profile photo');
    pick(png());
    expect(await screen.findByRole('button', { name: 'Change' })).toBeTruthy();
    openCreate();
    expect(await screen.findByRole('button', { name: 'Upload photo' })).toBeTruthy();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('venueGeofence helpers', () => {
  const base = { lat: '', lng: '', geofenceRadiusM: '200', enforceGeofence: false };

  it('accepts a blank/off configuration and a fully valid enforced one', () => {
    expect(validateGeofence(base)).toEqual({});
    expect(validateGeofence({ lat: '51.5', lng: '-0.12', geofenceRadiusM: '100', enforceGeofence: true })).toEqual({});
  });

  it('rejects Infinity, exponent and hex forms that Number() would accept', () => {
    for (const bad of ['Infinity', '1e2', '0x10', '--1', '1,5']) {
      expect(validateGeofence({ ...base, lat: bad, lng: '0' }).lat).toBeTruthy();
    }
  });

  it('accepts the boundary values', () => {
    expect(validateGeofence({ ...base, lat: '90', lng: '180' })).toEqual({});
    expect(validateGeofence({ ...base, lat: '-90', lng: '-180' })).toEqual({});
    expect(validateGeofence({ ...base, geofenceRadiusM: '50' })).toEqual({});
  });

  it('buildGeofencePayload omits blanks on create and sends null on edit', () => {
    expect(buildGeofencePayload({ ...base, geofenceRadiusM: '' }, false)).toEqual({ lat: undefined, lng: undefined, geofenceRadiusM: undefined, enforceGeofence: false });
    expect(buildGeofencePayload({ ...base, geofenceRadiusM: '' }, true)).toEqual({ lat: null, lng: null, geofenceRadiusM: undefined, enforceGeofence: false });
  });

  it('parseCoordinatePair understands Google Maps copies and ignores anything else', () => {
    expect(parseCoordinatePair('51.5074, -0.1278')).toEqual({ lat: '51.5074', lng: '-0.1278' });
    expect(parseCoordinatePair('51.5074 -0.1278')).toEqual({ lat: '51.5074', lng: '-0.1278' });
    expect(parseCoordinatePair('51.5074')).toBeNull();
    expect(parseCoordinatePair('hello, world')).toBeNull();
  });
});
