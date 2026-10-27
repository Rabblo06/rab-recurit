import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import SecurityModal from './SecurityModal';

function Harness({ dismissable = true }: { dismissable?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open && (
        <SecurityModal
          open
          titleId="t"
          descriptionId="d"
          title="Confirm it’s you"
          description="Enter your password."
          onClose={dismissable ? () => setOpen(false) : undefined}
          footer={
            <button type="button" onClick={() => setOpen(false)}>
              Done
            </button>
          }
        >
          <label htmlFor="pw">Current password</label>
          <input id="pw" />
        </SecurityModal>
      )}
    </>
  );
}

it('is a labelled modal dialog that focuses its first field', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
  const dialog = screen.getByRole('dialog', { name: 'Confirm it’s you' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveAccessibleDescription('Enter your password.');
  await waitFor(() =>
    expect(screen.getByLabelText('Current password')).toHaveFocus(),
  );
});

it('Tab and Shift+Tab cycle inside the dialog', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current password')).toHaveFocus(),
  );
  const close = screen.getByRole('button', { name: 'Close' });
  const done = screen.getByRole('button', { name: 'Done' });
  done.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(done).toHaveFocus();
});

it('Escape closes it and focus returns to the opener', async () => {
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open dialog' });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() =>
    expect(screen.getByLabelText('Current password')).toHaveFocus(),
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(opener).toHaveFocus());
});

it('a non-dismissable step (unsaved recovery codes) has no close button and ignores Escape', async () => {
  render(<Harness dismissable={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
  expect(
    screen.queryByRole('button', { name: 'Close' }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
