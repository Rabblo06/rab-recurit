import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import {
  AvailabilityConflict,
  AvailabilityConflictDialog,
  availabilityAcknowledgements,
  readAvailabilityConflict,
  useAvailabilityConflictGate,
} from './AvailabilityConflictDialog';

const john = { staffProfileId: 's-john', staffName: 'John Smith', availableDays: ['Tuesday', 'Sunday'], conflictDates: [{ date: '2026-10-19', weekday: 'Monday' }] };
const single: AvailabilityConflict = {
  code: 'STAFF_AVAILABILITY_CONFLICT',
  message: 'John Smith has marked themselves as unavailable on Monday. Available days: Tuesday and Sunday.',
  totalRecipients: 1,
  conflicts: [john],
  unknownAvailability: [],
};
const bulk: AvailabilityConflict = {
  ...single,
  message: '3 of 10 selected Staff have availability conflicts.',
  totalRecipients: 10,
  conflicts: [
    john,
    { staffProfileId: 's-amy', staffName: 'Amy Lee', availableDays: ['Saturday'], conflictDates: [{ date: '2026-10-19', weekday: 'Monday' }] },
    { staffProfileId: 's-bo', staffName: 'Bo Chan', availableDays: ['Friday', 'Wednesday'], conflictDates: [{ date: '2026-10-19', weekday: 'Monday' }] },
  ],
  unknownAvailability: [{ staffProfileId: 's-x', staffName: 'Xan Unknown' }],
};
const axios409 = (data: unknown) => ({ response: { status: 409, data } });

it('single recipient: names the day and the declared days, with Cancel and Send anyway', () => {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  render(<AvailabilityConflictDialog conflict={single} onCancel={onCancel} onConfirm={onConfirm} />);
  expect(screen.getByRole('alertdialog', { name: 'Staff availability warning' })).toBeInTheDocument();
  expect(screen.getByText('John Smith has marked themselves as unavailable on Monday.')).toBeInTheDocument();
  expect(screen.getByText('Available days: Tuesday and Sunday.')).toBeInTheDocument();
  expect(screen.getByText('You can cancel or choose to send the offer anyway.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('bulk: shows the "N of M" summary, every affected person with date and days, and unknown availability as not-unavailable', () => {
  render(<AvailabilityConflictDialog conflict={bulk} onCancel={jest.fn()} onConfirm={jest.fn()} />);
  expect(screen.getByText('3 of 10 selected Staff have availability conflicts.')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Staff with availability conflicts' });
  expect(list.querySelectorAll('li')).toHaveLength(3);
  expect(list).toHaveTextContent('John Smith');
  expect(list).toHaveTextContent('Unavailable on Monday 19 October');
  expect(list).toHaveTextContent('Available days: Wednesday and Friday');
  expect(screen.getByText(/1 selected person has not provided availability — that is not treated as unavailable/)).toBeInTheDocument();
});

it('Escape cancels', () => {
  const onCancel = jest.fn();
  render(<AvailabilityConflictDialog conflict={single} onCancel={onCancel} onConfirm={jest.fn()} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalled();
});

it('reads only the typed 409 and builds date-specific acknowledgements', () => {
  expect(readAvailabilityConflict(axios409(single))?.conflicts).toHaveLength(1);
  expect(readAvailabilityConflict(axios409({ code: 'SOMETHING_ELSE', conflicts: [] }))).toBeNull();
  expect(readAvailabilityConflict({ response: { status: 400, data: single } })).toBeNull();
  expect(readAvailabilityConflict(new Error('network'))).toBeNull();
  expect(availabilityAcknowledgements(bulk)).toEqual([
    { staffProfileId: 's-john', dates: ['2026-10-19'] },
    { staffProfileId: 's-amy', dates: ['2026-10-19'] },
    { staffProfileId: 's-bo', dates: ['2026-10-19'] },
  ]);
});

function Harness({ error, resend }: { error: unknown; resend: jest.Mock }) {
  const gate = useAvailabilityConflictGate();
  const [handled, setHandled] = useState<boolean | null>(null);
  return (
    <>
      <button onClick={() => setHandled(gate.intercept(error, resend))}>fail</button>
      <span>{handled === null ? 'idle' : handled ? 'intercepted' : 'not-intercepted'}</span>
      {gate.dialog}
    </>
  );
}

it('gate: Cancel dispatches nothing; Send anyway re-sends once with the acknowledgements', () => {
  const resend = jest.fn();
  const { rerender } = render(<Harness error={axios409(single)} resend={resend} />);
  fireEvent.click(screen.getByText('fail'));
  expect(screen.getByText('intercepted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(resend).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();

  fireEvent.click(screen.getByText('fail'));
  fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
  expect(resend).toHaveBeenCalledTimes(1);
  expect(resend).toHaveBeenCalledWith([{ staffProfileId: 's-john', dates: ['2026-10-19'] }]);
  expect(screen.queryByRole('alertdialog')).toBeNull();

  rerender(<Harness error={{ response: { status: 500 } }} resend={resend} />);
  fireEvent.click(screen.getByText('fail'));
  expect(screen.getByText('not-intercepted')).toBeInTheDocument();
});
