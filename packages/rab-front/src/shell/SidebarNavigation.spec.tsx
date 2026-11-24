import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SidebarNavigation from './SidebarNavigation';
import { storageKey } from './nav-shortcuts';
jest.mock('../shared/lib/auth-session', () => ({ getUserId: () => 'test-user', subscribeToSession: () => () => {} }));
jest.mock('../shared/components/Popover', () => ({ __esModule: true, default: ({ open, children }: any) => open ? <div>{children}</div> : null }));
jest.mock('../shared/motion', () => ({ usePrefersReducedMotion: () => true }));
function mount(workspaceId = 'workspace-one') {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><SidebarNavigation userId="test-user" workspaceId={workspaceId} canSeeAudit isOrgAdmin collapsed={[]} onToggle={() => {}} workspace={<a href="/">Dashboard</a>} operations={<a href="/calendar">Calendar</a>} guide={<a href="/help">Help Center</a>} /></QueryClientProvider></MemoryRouter>);
}
function addFolder(section: string, name: string) {
  fireEvent.click(screen.getAllByRole('button', { name: `Add menu item to ${section}` })[0]!);
  fireEvent.click(screen.getByRole('button', { name: /^Folder$/ }));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: name } });
  fireEvent.keyDown(screen.getByLabelText('Folder name'), { key: 'Enter' });
}
beforeEach(() => { localStorage.clear(); jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });
test('section-specific additions remain drafts until Save and User Guide has no add action', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Edit workspace layout' }));
  expect(screen.getByRole('button', { name: 'Save layout' })).toBeDisabled();
  addFolder('Workspace', 'Team links');
  expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getByText('Team links')).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Operations' })).queryByText('Team links')).toBeNull();
  expect(within(screen.getByRole('navigation', { name: 'User Guide' })).queryByRole('button')).toBeNull();
  expect(localStorage.getItem(`${storageKey('test-user', 'workspace-one')}:workspace`)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
  expect(screen.getByRole('button', { name: 'Saving layout' })).toBeDisabled();
  act(() => jest.advanceTimersByTime(600));
  expect(JSON.parse(localStorage.getItem(`${storageKey('test-user', 'workspace-one')}:workspace`)!)[0].label).toBe('Team links');
});
test('Cancel discards additions and preserves existing Operations shortcuts', () => {
  localStorage.setItem(storageKey('test-user', 'workspace-one')!, JSON.stringify([{ id:'existing', kind:'folder', icon:'folder', label:'Existing', parentId:null }]));
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Edit workspace layout' }));
  addFolder('Operations', 'Unsaved');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText('Unsaved')).toBeNull(); expect(screen.getByText('Existing')).toBeInTheDocument();
});
test('workspace preferences do not leak to another workspace', () => {
  localStorage.setItem(`${storageKey('test-user', 'workspace-one')}:workspace`, JSON.stringify([{ id:'private', kind:'folder', icon:'folder', label:'Other workspace', parentId:null }]));
  mount('workspace-two'); expect(screen.queryByText('Other workspace')).toBeNull();
});


jest.mock('../shared/api', () => ({ api: { get: jest.fn() } }));

jest.mock('framer-motion', () => ({ ...jest.requireActual('framer-motion'), AnimatePresence: ({ children }: any) => children }));
test('built-in row edits preserve destinations and Cancel restores the original label', () => {
  function Link({ item }: { item: { to: string; label: string } }) { return <a href={item.to}>{item.label}</a>; }
  render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><SidebarNavigation userId="test-user" workspaceId="workspace-one" canSeeAudit isOrgAdmin collapsed={[]} onToggle={() => {}} workspace={<><Link item={{ to: '/', label: 'Dashboard' }} /><Link item={{ to: '/users', label: 'Users' }} /></>} operations={<Link item={{ to: '/calendar', label: 'Calendar' }} />} guide={<a href="/help">Help</a>} /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Edit workspace layout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Options for Users' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('link', { name: 'Team' })).toHaveAttribute('href', '/users');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users');
  expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
});
test('adding directly inside a folder persists the chosen folder', () => {
  localStorage.setItem(`${storageKey('test-user', 'workspace-one')}:workspace`, JSON.stringify([{ id: 'king-folder', kind: 'folder', icon: 'folder', label: 'king', parentId: null }]));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Edit workspace layout' }));
  expect(screen.queryByText('Empty folder')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add menu item to king' }));
  fireEvent.click(screen.getByRole('button', { name: 'Object' }));
  fireEvent.click(screen.getByRole('button', { name: 'Users' }));
  const link = screen.getByRole('link', { name: 'Users' });
  expect(link.closest('.shortcut-children')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
  act(() => jest.advanceTimersByTime(600));
  const stored = JSON.parse(localStorage.getItem(`${storageKey('test-user', 'workspace-one')}:workspace`)!);
  expect(stored.find((item: any) => item.target === 'users').parentId).toBe('king-folder');
});



test('Object menu labels existing destinations without blocking available pages', async () => {
  const { AddMenuItem } = await import('./NavShortcuts');
  const add = jest.fn();
  render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><AddMenuItem initiallyOpen shortcuts={[]} existingObjectTargets={['users']} canSeeAudit onAdd={add} /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Object' }));
  await act(async () => { jest.advanceTimersByTime(200); });
  expect(screen.getByRole('button', { name: 'Users · Already in sidebar' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Venues' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search Object' }), { target: { value: 'Venues' } });
  fireEvent.click(screen.getByRole('button', { name: 'Venues' }));
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: 'object', target: 'venues' }));
});

test('new action menu moves an existing destination into a folder and saves its route', () => {
  const key = `${storageKey('test-user', 'workspace-one')}:workspace`;
  localStorage.setItem(key, JSON.stringify([{ id:'team', kind:'folder', icon:'folder', label:'Team', parentId:null }]));
  function Link({ item }: { item: { to:string; label:string } }) { return <a href={item.to}>{item.label}</a>; }
  const view = render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><SidebarNavigation userId="test-user" workspaceId="workspace-one" canSeeAudit isOrgAdmin collapsed={[]} onToggle={() => {}} workspace={<Link item={{to:'/users',label:'Users'}}/>} operations={null} guide={null}/></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', {name:'Edit workspace layout'}));
  fireEvent.click(screen.getByRole('button', {name:'Options for Users'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Move to folder'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Team'}));
  expect(screen.getByRole('link', {name:'Users'}).closest('.shortcut-children')).not.toBeNull();
  expect(screen.getByRole('link', {name:'Users'})).toHaveAttribute('href','/users');
  fireEvent.click(screen.getByRole('button', {name:'Save layout'}));
  act(() => jest.advanceTimersByTime(600));
  expect(JSON.parse(localStorage.getItem(key)!).find((item:any)=>item.target==='users')).toMatchObject({parentId:'team'});
  view.unmount();
});

test('add before inserts in place and Cancel discards the change', () => {
  const key = `${storageKey('test-user', 'workspace-one')}:workspace`;
  localStorage.setItem(key, JSON.stringify([{ id:'users',kind:'object',target:'users',icon:'person',label:'Users',parentId:null }]));
  mount();
  fireEvent.click(screen.getByRole('button', {name:'Edit workspace layout'}));
  fireEvent.click(screen.getByRole('button', {name:'Options for Users'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Add menu item before'}));
  fireEvent.click(screen.getByRole('button', {name:'Object'}));
  fireEvent.click(screen.getByRole('button', {name:'Venues'}));
  const links = within(screen.getByRole('navigation', {name:'Workspace'})).getAllByRole('link');
  expect(links.map(link => link.textContent)).toEqual(['Dashboard','Venues','Users']);
  fireEvent.click(screen.getByRole('button', {name:'Cancel'}));
  expect(screen.queryByRole('link', {name:'Venues'})).toBeNull();
});

test('existing folder Rename edits inline; Escape cancels and Enter keeps the new name', () => {
  localStorage.setItem(`${storageKey('test-user', 'workspace-one')}:workspace`, JSON.stringify([{id:'folder',kind:'folder',icon:'folder',label:'Team',parentId:null}]));
  mount();
  fireEvent.click(screen.getByRole('button', {name:'Edit workspace layout'}));
  fireEvent.click(screen.getByRole('button', {name:'Options for Team'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Rename'}));
  expect(screen.getByLabelText('Folder name').closest('.shortcut-folder-row')).not.toBeNull();
  fireEvent.change(screen.getByLabelText('Folder name'), {target:{value:'Discarded'}});
  fireEvent.keyDown(screen.getByLabelText('Folder name'), {key:'Escape'});
  expect(screen.getByRole('button', {name:'Team'})).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('button', {name:'Team'}), {key:'F2'});
  fireEvent.change(screen.getByLabelText('Folder name'), {target:{value:'Team links'}});
  fireEvent.keyDown(screen.getByLabelText('Folder name'), {key:'Enter'});
  expect(screen.getByRole('button', {name:'Team links'})).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Options for Team links'})).toBeInTheDocument();
});
