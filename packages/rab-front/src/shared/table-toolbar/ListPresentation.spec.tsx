import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListViewSelect, RecordFooter } from './ListPresentation';

const options = [{ value: '', label: 'All requests' }, { value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'declined', label: 'Declined' }];
function Example({ onChange = jest.fn() }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('');
  return <div style={{ overflow: 'hidden' }}><ListViewSelect label="Request view" value={value} options={options} onChange={next => { setValue(next); onChange(next); }}/><button>Next control</button></div>;
}

it('portals all four options, selects the real value and restores trigger focus', async () => {
  const onChange = jest.fn();
  const { container } = render(<Example onChange={onChange}/>);
  const trigger = screen.getByRole('combobox');
  await userEvent.click(trigger);
  const list = await screen.findByRole('listbox');
  expect(container.contains(list)).toBe(false);
  expect(screen.getAllByRole('option')).toHaveLength(4);
  expect(screen.getByRole('option', { name: 'All requests' })).toHaveAttribute('aria-selected', 'true');
  await userEvent.click(screen.getByRole('option', { name: 'Pending' }));
  expect(onChange).toHaveBeenCalledWith('pending');
  expect(trigger).toHaveTextContent('Pending');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
  await userEvent.click(trigger);
  expect(await screen.findByRole('option', { name: 'Pending' })).toHaveAttribute('aria-selected', 'true');
  await userEvent.click(screen.getByRole('option', { name: 'All requests' }));
  expect(onChange).toHaveBeenLastCalledWith('');
});

it('supports arrows, Home/End, typeahead and Enter/Space without selecting on focus', async () => {
  const onChange = jest.fn();
  render(<Example onChange={onChange}/>);
  const trigger = screen.getByRole('combobox');
  trigger.focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(onChange).not.toHaveBeenCalled();
  expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Pending' }).id);
  await userEvent.keyboard('{Enter}');
  expect(onChange).toHaveBeenLastCalledWith('pending');
  await userEvent.keyboard('{ArrowUp}{End} ');
  expect(onChange).toHaveBeenLastCalledWith('declined');
  await userEvent.keyboard('{Home}{Enter}');
  expect(onChange).toHaveBeenLastCalledWith('');
  await userEvent.keyboard('ap{Enter}');
  expect(onChange).toHaveBeenLastCalledWith('approved');
});

it('Escape and outside click close without changing the selection; Tab moves on', async () => {
  const onChange = jest.fn();
  render(<Example onChange={onChange}/>);
  const trigger = screen.getByRole('combobox');
  await userEvent.click(trigger);
  await userEvent.keyboard('{ArrowDown}{Escape}');
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(trigger);
  fireEvent.mouseDown(document.body);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(trigger);
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(onChange).not.toHaveBeenCalled();
});

describe('RecordFooter paging (Phase C1: explicit page size, never the old 500)', () => {
  it('pages by the requested limit (50 by default) and reaches page 2', async () => {
    const onPage = jest.fn();
    render(<RecordFooter total={120} page={1} onPage={onPage} />);
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
  it('uses the page size the list was requested with', () => {
    render(<RecordFooter total={120} page={1} onPage={jest.fn()} pageSize={100} />);
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });
});
