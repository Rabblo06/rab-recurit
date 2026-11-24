import { fireEvent, render, screen } from '@testing-library/react';
import DateInput, { isoToDisplay } from './DateInput';

beforeEach(() => {
  window.matchMedia = jest.fn().mockImplementation((media: string) => ({
    matches: true, media, onchange: null, addListener: jest.fn(), removeListener: jest.fn(),
    addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
  }));
});

it('keeps typed British dates and calendar-day values without UTC conversion', () => {
  const onChange = jest.fn();
  render(<DateInput value="2026-11-23" onChange={onChange} />);
  const input = screen.getByPlaceholderText('DD/MM/YYYY');
  fireEvent.change(input, { target: { value: '01/12/2026' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('2026-12-01');
  expect(isoToDisplay('2026-12-01')).toBe('01/12/2026');
});

it('rejects impossible dates and values outside inclusive limits', () => {
  const onChange = jest.fn();
  render(<DateInput value="" min="2026-11-20" max="2026-12-15" onChange={onChange} />);
  const input = screen.getByPlaceholderText('DD/MM/YYYY');
  for (const value of ['31/11/2026', '19/11/2026', '16/12/2026']) {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '20/11/2026' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('2026-11-20');
});

it('uses the Arc calendar inside the existing portal and commits a bounded pick', () => {
  const onChange = jest.fn();
  const { container } = render(<DateInput value="2026-11-23" min="2026-11-20" max="2026-12-15" onChange={onChange} />);
  fireEvent.focus(screen.getByPlaceholderText('DD/MM/YYYY'));
  const dialog = screen.getByRole('dialog', { name: 'Choose date' });
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.querySelector('[data-date="2026-11-19"]')).toBeDisabled();
  fireEvent.click(dialog.querySelector('[data-date="2026-11-24"]')!);
  expect(onChange).toHaveBeenLastCalledWith('2026-11-24');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByPlaceholderText('DD/MM/YYYY')).toHaveFocus();
});
