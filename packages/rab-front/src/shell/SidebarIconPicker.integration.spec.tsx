import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import SidebarIconPicker from './SidebarIconPicker';
import { type SidebarIcon, SIDEBAR_ICON_IDS } from './sidebar-icons';
import { parseShortcuts } from './nav-shortcuts';

function Picker() {
  const [appearance, setAppearance] = useState<{ icon?: SidebarIcon; color?: string }>({ icon: 'folder' });
  return <><SidebarIconPicker label="Folder" {...appearance} onChange={(icon, color) => setAppearance({ icon, color })} /><button>Outside</button></>;
}

test('nested portal keeps the icon card and independent search, previews color and dismisses one layer per Escape', async () => {
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: 'Change icon for Folder' }));
  const icons = await screen.findByLabelText('Search icons');
  fireEvent.change(icons, { target: { value: 'map' } });
  fireEvent.click(screen.getByRole('button', { name: 'Choose icon color' }));
  const colors = await screen.findByLabelText('Search colors');
  fireEvent.mouseDown(colors);
  fireEvent.change(colors, { target: { value: 'Ruby' } });
  expect(icons).toHaveValue('map');
  fireEvent.click(screen.getByRole('option', { name: 'Ruby' }));
  await waitFor(() => expect(screen.queryByLabelText('Search colors')).not.toBeInTheDocument());
  expect(screen.getByRole('group', { name: 'Icons' })).toHaveStyle({ color: '#e54666' });
  fireEvent.click(screen.getByRole('button', { name: 'Choose icon color' }));
  await screen.findByLabelText('Search colors');
  expect(screen.getByRole('option', { name: 'Ruby' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByLabelText('Search colors')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Search icons')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Choose icon color' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByLabelText('Search icons')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Change icon for Folder' })).toHaveFocus();
});

test('outside pointer dismisses both cards and expanded icon IDs round-trip through existing storage', async () => {
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: 'Change icon for Folder' }));
  await screen.findByLabelText('Search icons');
  expect(within(screen.getByRole('group', { name: 'Icons' })).getAllByRole('button')).toHaveLength(25);
  expect(SIDEBAR_ICON_IDS.length).toBeGreaterThan(4000);
  fireEvent.click(screen.getByRole('button', { name: 'Choose icon color' }));
  await screen.findByLabelText('Search colors');
  fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
  await waitFor(() => expect(screen.queryByLabelText('Search icons')).not.toBeInTheDocument());
  expect(screen.queryByLabelText('Search colors')).not.toBeInTheDocument();
  const shortcut = { id: 'folder', kind: 'folder', label: 'Team', icon: 'building-hospital', color: '#e54666' };
  expect(parseShortcuts(JSON.stringify([shortcut]))[0]).toMatchObject(shortcut);
});

test('scroll reveals the next 25 icons and search resets the window', async () => {
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: 'Change icon for Folder' }));
  const search = await screen.findByLabelText('Search icons');
  const grid = screen.getByRole('group', { name: 'Icons' });
  fireEvent.scroll(grid);
  expect(within(grid).getAllByRole('button')).toHaveLength(50);
  fireEvent.change(search, { target: { value: 'zodiac' } });
  expect(within(grid).getAllByRole('button')).toHaveLength(12);
  fireEvent.change(search, { target: { value: '' } });
  expect(within(grid).getAllByRole('button')).toHaveLength(25);
});
