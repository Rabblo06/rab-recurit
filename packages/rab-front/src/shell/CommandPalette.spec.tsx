import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import CommandPalette from './CommandPalette';

// jsdom has no layout, so it does not implement scrollIntoView (the palette scrolls the active row into view).
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.hash}</output>;
}

function mount() {
  const onClose = jest.fn();
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<><Where /><CommandPalette open onClose={onClose} onOpenSearch={jest.fn()} onOpenTimeline={jest.fn()} /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}

describe('Command palette settings shortcuts', () => {
  // A `/settings#…` fragment is ignored by the router: all three used to land on Settings → Profile.
  it.each([
    ['Go to Account Settings', '/settings/account'],
    ['Go to General Settings', '/settings/my-workspace'],
    ['Go to Role/Permission Settings', '/settings/workspace/roles'],
  ])('%s opens %s', (label, path) => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByTestId('where').textContent).toBe(path);
    expect(onClose).toHaveBeenCalled();
  });

  it('never navigates to a settings fragment', () => {
    mount();
    for (const label of ['Go to Account Settings', 'Go to General Settings', 'Go to Role/Permission Settings']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByTestId('where').textContent).not.toContain('#');
    }
  });
});
