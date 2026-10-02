import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AvatarUploadButton from './AvatarUploadButton';
import { toast } from '../../shared/lib/toast';

jest.mock('../../shared/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// `Avatar` fetches its image over `api` when given an `imageKey` — not this
// component's concern to test (see Avatar's own tests, if any); keep these
// focused on the upload-interaction/validation logic only.
jest.mock('../../shared/api', () => ({ api: { get: jest.fn().mockResolvedValue({ data: new Blob() }) } }));

const mockToast = toast as unknown as { success: jest.Mock; error: jest.Mock };

function png(name = 'avatar.png', size = 1024): File {
  const file = new File([new Uint8Array(size)], name, { type: 'image/png' });
  return file;
}

beforeEach(() => {
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

describe('AvatarUploadButton', () => {
  it('clicking the avatar opens the hidden file picker', async () => {
    const onFileSelected = jest.fn();
    render(<AvatarUploadButton label="Jordan" onFileSelected={onFileSelected} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = jest.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Change photo' }));
    expect(clickSpy).toHaveBeenCalled();
  });

  it('a valid PNG under the size limit is accepted and reported via onFileSelected', async () => {
    const onFileSelected = jest.fn();
    render(<AvatarUploadButton label="Jordan" onFileSelected={onFileSelected} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = png();
    await userEvent.upload(input, file);

    expect(onFileSelected).toHaveBeenCalledWith(file);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('rejects a non-image MIME type before calling onFileSelected or touching the network', () => {
    // `userEvent.upload` respects the input's own `accept` filter (as a
    // real browser's file picker would) and refuses to "select" a
    // mismatched file at all, which would make this assert nothing about
    // the component's OWN validation — defense-in-depth against a file
    // dropped in via drag-and-drop or a renamed extension, which bypasses
    // `accept` entirely. `fireEvent` fires the native `change` event
    // directly, exercising that validation path regardless.
    const onFileSelected = jest.fn();
    render(<AvatarUploadButton label="Jordan" onFileSelected={onFileSelected} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File(['not an image'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [badFile] });
    fireEvent.change(input);

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('PNG, JPEG or WEBP'));
  });

  it('rejects a file over the 10MB limit before calling onFileSelected', async () => {
    const onFileSelected = jest.fn();
    render(<AvatarUploadButton label="Jordan" onFileSelected={onFileSelected} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const tooBig = png('big.png', 11 * 1024 * 1024);
    await userEvent.upload(input, tooBig);

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('10MB'));
  });

  it('is disabled while a caller-driven upload is in flight', () => {
    const onFileSelected = jest.fn();
    render(<AvatarUploadButton label="Jordan" onFileSelected={onFileSelected} disabled />);
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeDisabled();
  });
});
