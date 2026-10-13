import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Calendar from './Calendar';
import { api } from '../../shared/api';
jest.mock('../../shared/api',()=>({api:{get:jest.fn()}}));
const get=api.get as jest.Mock;
const date=new Date();
const workday=new Date(date.getFullYear(),date.getMonth(),15,9);
function mount(fail=false){
 get.mockImplementation((url:string)=>{
  if(url==='/shifts')return fail?Promise.reject(new Error('offline')):Promise.resolve({data:{data:[{id:'shift',venueId:'venue',jobRoleId:'role',startsAt:workday.toISOString(),endsAt:new Date(workday.getTime()+8*3600000).toISOString(),requiredCount:2,filledCount:1,status:'fully_filled'}]}});
  if(url==='/venues')return Promise.resolve({data:[{id:'venue',name:'Example hall'}]});
  if(url==='/job-roles')return Promise.resolve({data:[{id:'role',name:'Waiting staff'}]});
  if(url==='/offers')return Promise.resolve({data:{total:2,data:[{id:'offer',shiftId:'shift',staffName:'Casey Example',status:'manager_confirmed'},{id:'foreign',shiftId:'another-shift',staffName:'Other Shift Person',status:'manager_confirmed'}]}});
  throw new Error(url);
 });
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Calendar /></QueryClientProvider>);
}
beforeEach(()=>get.mockReset());
it('uses the current month and shows the selected day’s actual shift and confirmed staff only',async()=>{
 mount();expect(screen.getByRole('heading',{name:date.toLocaleDateString('en-GB',{month:'long',year:'numeric'})})).toBeInTheDocument();
 const label=workday.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})+', 1 shifts';
 fireEvent.click(await screen.findByRole('button',{name:label}));
 const panel=within(screen.getByRole('complementary',{name:'Selected day'}));
 expect(await panel.findByText('Casey Example')).toBeInTheDocument();
 expect(panel.getByText('Example hall')).toBeInTheDocument();
 expect(panel.queryByText('Other Shift Person')).toBeNull();
});
it('month navigation requests the new range and Add shift opens the existing drawer event',async()=>{
 mount();await screen.findByRole('group',{name:'Month calendar'});const requests=get.mock.calls.filter(([url])=>url==='/shifts').length;
 fireEvent.click(screen.getByRole('button',{name:'Next month'}));
 await waitFor(()=>expect(get.mock.calls.filter(([url])=>url==='/shifts').length).toBeGreaterThan(requests));
 const opened=jest.fn();document.addEventListener('open-create-placement',opened);
 fireEvent.click(screen.getByRole('button',{name:'Add shift'}));expect(opened).toHaveBeenCalledTimes(1);document.removeEventListener('open-create-placement',opened);
});
it('a failed schedule query is an error rather than an empty schedule claim',async()=>{
 mount(true);expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the schedule');
 expect(screen.getByText('Schedule unavailable')).toBeInTheDocument();
});
