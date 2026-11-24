import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffSelect from './StaffSelect';
function Fixture() { const [value, setValue] = useState(''); return <><label htmlFor="shift">Shift time</label><StaffSelect id="shift" label="Shift time" value={value} onChange={setValue} placeholder="Select time" options={[{value:'',label:'None'},{value:'Morning',label:'Morning'},{value:'Evening',label:'Evening'}]} /></>; }
it('searches and selects exactly one value, retaining it when reopened', async () => {
  render(<Fixture />);
  await userEvent.click(screen.getByRole('button', { name: 'Shift time' }));
  await userEvent.type(await screen.findByRole('combobox'), 'eve');
  expect(screen.queryByRole('option', {name:'Morning'})).toBeNull();
  await userEvent.click(screen.getByRole('option', {name:'Evening'}));
  expect(screen.getByRole('button', { name: 'Shift time' })).toHaveTextContent('Evening');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Shift time' }));
  expect(await screen.findByRole('option', {name:'Evening'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('option', {name:'Morning'})).toHaveAttribute('aria-selected','false');
});
it('supports keyboard selection and Escape without changing the value', async () => {
  Element.prototype.scrollIntoView = jest.fn();
  render(<Fixture />);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Shift time' }), {key:'ArrowDown'});
  const search = await screen.findByRole('combobox');
  fireEvent.keyDown(search, {key:'ArrowDown'}); fireEvent.keyDown(search, {key:'Enter'});
  expect(screen.getByRole('button', { name: 'Shift time' })).toHaveTextContent('Morning');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Shift time' }));
  fireEvent.keyDown(await screen.findByRole('combobox'), {key:'Escape'});
  expect(screen.getByRole('button', { name: 'Shift time' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Shift time' })).toHaveTextContent('Morning');
});
it('allows keyboard selection without rendering a search field', async () => {
  Element.prototype.scrollIntoView = jest.fn();
  const choose = jest.fn();
  render(<><label htmlFor="mode">Mode</label><StaffSelect id="mode" label="Mode" value="invite" onChange={choose} options={[{value:'invite',label:'Invite'},{value:'add',label:'Add'}]} placeholder="Mode" searchable={false} /></>);
  await userEvent.click(screen.getByRole('button', { name: 'Mode' }));
  const list = await screen.findByRole('listbox');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(list).toHaveFocus();
  fireEvent.keyDown(list, {key:'End'}); fireEvent.keyDown(list, {key:'Enter'});
  expect(choose).toHaveBeenCalledWith('add');
  expect(screen.getByRole('button', {name:'Mode'})).toHaveFocus();
});
