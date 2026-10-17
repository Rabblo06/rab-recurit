import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ToastHost from './ToastHost';
import { toast } from '../shared/lib/toast';

it('shows an error as an alert card with a draining countdown, and the countdown ending dismisses it', () => {
  const { container } = render(<ToastHost />);
  act(() => toast.error('Timesheet is not ready yet. Wait for all staff to clock out'));
  const card = screen.getByRole('alert');
  expect(card).toHaveClass('toast', 'toast-error');
  expect(card).toHaveTextContent('Timesheet is not ready yet');
  const bar = container.querySelector<HTMLElement>('.toast-progress')!;
  expect(bar.style.animationDuration).toBe('6000ms');
  fireEvent.animationEnd(bar);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('success uses the shorter countdown and the close button dismisses only that toast', async () => {
  const { container } = render(<ToastHost />);
  act(() => { toast.success('Staff member removed from this venue manager.'); toast.info('Saved draft.'); });
  expect(container.querySelector<HTMLElement>('.toast-success .toast-progress')!.style.animationDuration).toBe('4000ms');
  const [first] = screen.getAllByRole('button', { name: 'Dismiss notification' });
  await userEvent.click(first!);
  expect(screen.queryByText('Staff member removed from this venue manager.')).toBeNull();
  expect(screen.getByText('Saved draft.')).toBeInTheDocument();
});
