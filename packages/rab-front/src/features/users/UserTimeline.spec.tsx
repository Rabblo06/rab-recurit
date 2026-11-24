import { render, screen, within } from '@testing-library/react';
import UserTimeline from './UserTimeline';
const describeAction = (action: string) => action.replaceAll('.', ' ');
it('groups real events by month and year with actors and exact timestamp access', () => {
  render(<UserTimeline loading={false} describeAction={describeAction} items={[
    { id: '1', action: 'profile.updated', createdAt: '2026-11-04T12:00:00Z', actor: { fullName: 'Alex Morgan' } },
    { id: '2', action: 'attendance.clocked_in', createdAt: '2026-11-01T12:00:00Z' },
    { id: '3', action: 'user.created', createdAt: '2025-11-01T12:00:00Z' },
  ]} />);
  const current = screen.getByRole('region', { name: 'November 2026' });
  expect(within(current).getAllByRole('listitem')).toHaveLength(2);
  expect(within(current).getByText('Alex Morgan')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'November 2025' })).toBeInTheDocument();
  expect(current.querySelector('time')).toHaveAttribute('datetime', '2026-11-04T12:00:00.000Z');
  expect(screen.getByRole('button', {name:'Details: profile updated'})).toHaveAttribute('aria-expanded','false');
});
it('preserves empty and loading states without fabricated activity', () => {
  const { rerender } = render(<UserTimeline items={[]} loading describeAction={describeAction} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading activity');
  rerender(<UserTimeline items={[]} loading={false} describeAction={describeAction} />);
  expect(screen.getByText('No activity recorded yet.')).toBeInTheDocument();
});
