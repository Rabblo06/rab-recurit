import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommandPalette from './CommandPalette';
jest.mock('../shared/components/RightSidePanel', () => ({ __esModule: true, default: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null }));
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });
function mount(path: string) {
  render(<MemoryRouter initialEntries={[path]}><CommandPalette open onClose={jest.fn()} onOpenSearch={jest.fn()} onOpenTimeline={jest.fn()} /></MemoryRouter>);
}
test('Dashboard exposes existing overview tools first without duplicating commands', () => {
  mount('/');
  const group = screen.getByText('Current page · Dashboard').parentElement!;
  expect(within(group).getByRole('button', { name: /Go to Calendar/ })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Go to Calendar/ })).toHaveLength(1);
});
test('Users exposes people tools and preserves the AI eligibility gate', () => {
  mount('/users');
  const group = screen.getByText('Current page · Users').parentElement!;
  expect(within(group).getByRole('button', { name: /New User/ })).toBeInTheDocument();
  expect(within(group).getByRole('button', { name: /Search Users/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Ask AI/ })).not.toBeInTheDocument();
});

test('Up next exposes operational tools without duplicating destinations',()=>{
  mount('/up-next');
  const group=screen.getByText('Current page · Up next').parentElement!;
  expect(within(group).getByRole('button',{name:/Go to Open Shifts/})).toBeInTheDocument();
  expect(within(group).getByRole('button',{name:/Go to Awaiting Confirmation/})).toBeInTheDocument();
  expect(screen.getAllByRole('button',{name:/Go to Open Shifts/})).toHaveLength(1);
});
