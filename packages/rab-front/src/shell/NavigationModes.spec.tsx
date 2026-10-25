import { fireEvent, render, screen } from '@testing-library/react';

import NavigationModes from './NavigationModes';

/** AI chrome is never shown to a user the server has not confirmed as eligible (GET /ai/availability → available). */
it('hides the AI mode unless the user is confirmed eligible', () => {
  const select = jest.fn();
  const { rerender } = render(<NavigationModes mode="home" expanded onSelect={select} />);
  expect(screen.queryByRole('button', { name: 'AI' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  rerender(<NavigationModes mode="home" expanded onSelect={select} showAi />);
  fireEvent.click(screen.getByRole('button', { name: 'AI' }));
  expect(select).toHaveBeenCalledWith('ai');
});
