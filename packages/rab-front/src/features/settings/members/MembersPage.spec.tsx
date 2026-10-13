import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import MembersPage from './MembersPage';

jest.mock('../../../shared/api', () => ({api:{get:jest.fn(),post:jest.fn()}}));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

function mount(role = 'manager', options: { failDirectory?: boolean; pending?: boolean } = {}) {
  get.mockImplementation((url:string) => {
    if (url === '/auth/me') return Promise.resolve({data:{id:'viewer',roles:[role],isPlatformAdmin:false}});
    if (url.startsWith('/manager-workspaces/me')) return Promise.resolve({data:{id:'workspace',name:'Test workspace'}});
    if (url === '/staff' && options.failDirectory) return Promise.reject(new Error('Unavailable'));
    const rows = url === '/staff' && options.pending ? [{id:'member',firstName:'Test',lastName:'Member',email:'member@example.test',accountStatus:'invited',invitationStatus:'sent',pendingInvite:{sendNumber:1}}] : [];
    return Promise.resolve({data:{data:rows,total:rows.length}});
  });
  const qc = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/settings/workspace/members?tab=invite']}><MembersPage /></MemoryRouter></QueryClientProvider>);
}
async function fill() {
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'member@example.test'}});
  fireEvent.change(screen.getByLabelText('First name'),{target:{value:'Test'}});
  fireEvent.change(screen.getByLabelText('Last name'),{target:{value:'Member'}});
}
beforeEach(() => {get.mockReset();post.mockReset();});

it('a manager can invite Staff or Venue Managers, never Manager, CEO or Platform Super Admin', async () => {
  post.mockResolvedValue({data:{invite:{queued:true}}});mount();await fill();
  expect(screen.getAllByRole('option').map(el=>el.textContent)).toEqual(['Staff','Venue manager']);
  fireEvent.change(screen.getByLabelText('Workspace role'),{target:{value:'venue'}});
  fireEvent.click(screen.getByRole('button',{name:'Send invitation'}));
  await waitFor(()=>expect(post).toHaveBeenCalledWith('/venue-managers',{email:'member@example.test',firstName:'Test',lastName:'Member'}));
  expect(await screen.findByRole('status')).toHaveTextContent('Invitation queued');
});

it('a CEO can invite a Manager using the existing internal-manager endpoint, with no higher role choice', async () => {
  post.mockResolvedValue({data:{invite:{queued:true}}});mount('ceo');await fill();
  expect(screen.getAllByRole('option').map(el=>el.textContent)).toEqual(['Staff','Venue manager','Manager']);
  fireEvent.change(screen.getByLabelText('Workspace role'),{target:{value:'internal'}});
  fireEvent.click(screen.getByRole('button',{name:'Send invitation'}));
  await waitFor(()=>expect(post).toHaveBeenCalledWith('/managers',{email:'member@example.test',firstName:'Test',lastName:'Member',type:'internal'}));
});

it('a failed invitation never renders success or clears entered details', async () => {
  post.mockRejectedValue({response:{data:{message:'You cannot invite this role.'}}});mount();await fill();
  fireEvent.click(screen.getByRole('button',{name:'Send invitation'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('You cannot invite this role.');
  expect(screen.queryByText(/Invitation queued/)).toBeNull();
  expect(screen.getByLabelText('Email address')).toHaveValue('member@example.test');
});

it('a directory failure is reported instead of claiming there are no pending invitations', async () => {
  mount('manager',{failDirectory:true});
  expect(await screen.findByRole('alert')).toHaveTextContent('Invitations could not be loaded');
  expect(screen.queryByText(/No pending invitations/)).toBeNull();
});

it('revoking a pending invitation requires confirmation and uses the existing cancellation endpoint', async () => {
  post.mockResolvedValue({data:undefined});mount('manager',{pending:true});
  fireEvent.click(await screen.findByRole('button',{name:'Revoke'}));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Revoke invitation'}));
  await waitFor(()=>expect(post).toHaveBeenCalledWith('/staff/member/cancel-invite'));
  expect(await screen.findByRole('status')).toHaveTextContent('Invitation revoked.');
});

it('a staff identity sees no invitation form or administrative role controls', async () => {
  mount('staff');
  expect(await screen.findByText('Members are managed by your workspace administrator')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Send invitation'})).toBeNull();
  expect(get).not.toHaveBeenCalledWith('/staff');
});
