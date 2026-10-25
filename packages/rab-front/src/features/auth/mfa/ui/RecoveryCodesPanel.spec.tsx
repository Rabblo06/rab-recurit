import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import RecoveryCodesPanel from './RecoveryCodesPanel';

jest.mock('../../../../shared/api', () => ({ api: { post: jest.fn() } }));

const codes = Array.from(
  { length: 10 },
  (_, i) => `ABCD-EFGH-JKMN-PQ${String(i).padStart(2, '0')}`,
);

function Harness() {
  const [ack, setAck] = useState(false);
  return (
    <>
      <RecoveryCodesPanel
        codes={codes}
        accountLabel="me@example.test"
        acknowledged={ack}
        onAcknowledgedChange={setAck}
      />
      <button type="button" disabled={!ack}>
        Done
      </button>
    </>
  );
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

it('lists every real code (full length) once, and gates Done on the acknowledgement', () => {
  render(<Harness />);
  const list = screen.getByRole('list', { name: 'Recovery codes' });
  expect(list.querySelectorAll('li')).toHaveLength(10);
  expect(list).toHaveTextContent(codes[9]!);
  const done = screen.getByRole('button', { name: 'Done' });
  expect(done).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText('I’ve saved my recovery codes somewhere safe.'),
  );
  expect(done).toBeEnabled();
});

it('Copy codes writes plain text to the clipboard and announces it', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Copy codes/ }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      codes.join('\n'),
    ),
  );
  expect(await screen.findByText('Recovery codes copied.')).toBeInTheDocument();
});

it('a clipboard failure is explained, with the download as the next step', async () => {
  (navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(
    new Error('denied'),
  );
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Copy codes/ }));
  expect(
    await screen.findByText(
      /Couldn’t copy\. Select the codes and copy them, or download the file\./,
      { selector: 'p' },
    ),
  ).toBeInTheDocument();
});

it('Download .txt builds a local file (a Blob URL) — nothing is uploaded or stored', () => {
  const createObjectURL = jest.fn(() => 'blob:local');
  const revokeObjectURL = jest.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Download \.txt/ }));
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
  expect(blob.type).toContain('text/plain');
  expect(click).toHaveBeenCalled();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
  expect(setItem).not.toHaveBeenCalled();
  click.mockRestore();
  setItem.mockRestore();
});
