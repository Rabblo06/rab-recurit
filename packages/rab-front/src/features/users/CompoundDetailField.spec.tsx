import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompoundDetailField from './CompoundDetailField';
it('saves the existing name fields together',async()=>{
 const save=jest.fn().mockResolvedValue({});render(<CompoundDetailField kind="name" record={{firstName:'Alex',lastName:'Morgan'}} onSave={save}/>);
 await userEvent.click(screen.getByRole('button',{name:'Edit Name value'}));await userEvent.clear(screen.getByLabelText('First name'));await userEvent.type(screen.getByLabelText('First name'),'Jamie');await userEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(save).toHaveBeenCalledWith({firstName:'Jamie',lastName:'Morgan'}));
});
it('preserves existing extra address lines when only city changes',async()=>{
 const save=jest.fn().mockResolvedValue({});render(<CompoundDetailField kind="address" record={{address:'10 Road\nFlat 2\nCA\nUnited States',city:'Old city',postcode:'12345'}} onSave={save}/>);
 await userEvent.click(screen.getByRole('button',{name:'Edit Address value'}));await userEvent.clear(screen.getByLabelText('City'));await userEvent.type(screen.getByLabelText('City'),'New city');await userEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(save).toHaveBeenCalledWith({address:'10 Road\nFlat 2\nCA\nUnited States',city:'New city',postcode:'12345'}));
});
