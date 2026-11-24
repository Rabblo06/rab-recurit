import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NameInput from './NameInput';
function Form() {
  const [name, setName] = useState({ firstName: '', lastName: '' });
  return <NameInput {...name} onChange={setName} />;
}
it('splits a full name into first name and the remaining surname, and recombines edits', async () => {
  render(<Form />);
  const full = screen.getByRole('textbox', { name: 'Name *' });
  await userEvent.type(full, 'issac abin nepolean');
  await userEvent.click(screen.getByRole('button', { name: 'Expand name fields' }));
  expect(screen.getByLabelText('First name')).toHaveValue('issac');
  expect(screen.getByLabelText('Last name')).toHaveValue('abin nepolean');
  await userEvent.clear(screen.getByLabelText('First name'));
  await userEvent.type(screen.getByLabelText('First name'), 'Issac');
  expect(full).toHaveValue('Issac abin nepolean');
  await userEvent.click(screen.getByRole('button', { name: 'Collapse name fields' }));
  expect(screen.queryByRole('textbox', { name: 'Last name' })).toBeNull();
  expect(full).toHaveValue('Issac abin nepolean');
});
it('preserves spaces while typing and clears both parts when the full name is cleared', async () => {
  render(<Form />);
  const full = screen.getByRole('textbox', { name: 'Name *' });
  await userEvent.type(full, 'Alex ');
  expect(full).toHaveValue('Alex ');
  await userEvent.clear(full);
  await userEvent.click(screen.getByRole('button', { name: 'Expand name fields' }));
  expect(screen.getByLabelText('First name')).toHaveValue('');
  expect(screen.getByLabelText('Last name')).toHaveValue('');
});
