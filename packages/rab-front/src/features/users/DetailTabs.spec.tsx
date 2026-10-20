import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import DetailTabs from './DetailTabs';

type T = 'home' | 'timeline' | 'email' | 'note' | 'reviews';
function Harness() {
  const [tab, setTab] = useState<T>('home');
  return (
    <>
      <DetailTabs<T>
        primary={[
          { id: 'home', label: 'Overview', icon: null },
          { id: 'timeline', label: 'Timeline', icon: null },
          { id: 'email', label: 'Email', icon: null },
        ]}
        overflow={[
          { id: 'note', label: 'Notes', icon: null },
          { id: 'reviews', label: 'Staff reviews', icon: null },
        ]}
        value={tab}
        onChange={setTab}
      />
      <p data-testid="current">{tab}</p>
      <button type="button">outside</button>
    </>
  );
}

it('three primary tabs and a "+2 More" menu; choosing an overflow tab shows it as the active tab', async () => {
  render(<Harness />);
  expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Overview', 'Timeline', 'Email']);
  await userEvent.click(screen.getByRole('button', { name: /2 More/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: /Staff reviews/ }));
  expect(screen.getByTestId('current')).toHaveTextContent('reviews');
  expect(screen.getByRole('tab', { name: /Staff reviews/ })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull()); // after the 130ms exit
  // The trigger shrinks to a labelled chevron so the strip does not clip.
  expect(screen.getByRole('button', { name: 'More tabs' })).toBeInTheDocument();
});

it('keyboard: ArrowDown opens on the first item, arrows move, Enter chooses, Escape closes and returns focus', async () => {
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: /2 More/ });
  trigger.focus();
  await userEvent.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitem', { name: /Notes/ })).toHaveFocus();
  await userEvent.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitem', { name: /Staff reviews/ })).toHaveFocus();
  await userEvent.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitem', { name: /Notes/ })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull()); // after the 130ms exit
  expect(trigger).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await userEvent.keyboard('{Enter}');
  expect(screen.getByTestId('current')).toHaveTextContent('note');
});

it('closes on an outside click without changing the tab', async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: /2 More/ }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'outside' }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull()); // after the 130ms exit
  expect(screen.getByTestId('current')).toHaveTextContent('home');
});
