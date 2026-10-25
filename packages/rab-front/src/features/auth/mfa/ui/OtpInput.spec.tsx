import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import OtpInput from './OtpInput';

function Harness({
  onComplete,
  invalid = false,
}: {
  onComplete?: (v: string) => void;
  invalid?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <OtpInput
      value={value}
      onChange={setValue}
      onComplete={onComplete}
      invalid={invalid}
      describedBy={invalid ? 'err' : undefined}
    />
  );
}

const input = () =>
  screen.getByLabelText('6-digit authentication code') as HTMLInputElement;
const boxes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.acs-otp-box')).map(
    (b) => b.textContent,
  );

it('is ONE labelled real input with one-time-code autofill and a numeric keyboard; the six boxes are hidden from AT', () => {
  const { container } = render(<Harness />);
  const el = input();
  expect(el.tagName).toBe('INPUT');
  expect(el).toHaveAttribute('autocomplete', 'one-time-code');
  expect(el).toHaveAttribute('inputmode', 'numeric');
  expect(el).toHaveAttribute('pattern', '[0-9]*');
  expect(el).not.toHaveAttribute('maxlength'); // a pasted "482 913" must not be cut to "482 91"
  expect(container.querySelectorAll('input')).toHaveLength(1);
  const painted = container.querySelectorAll('.acs-otp-box');
  expect(painted).toHaveLength(6);
  painted.forEach((b) => expect(b).toHaveAttribute('aria-hidden', 'true'));
  expect(boxes(container)).toEqual(['—', '—', '—', '—', '—', '—']);
});

it('typing keeps digits only, at most six, and fills the boxes', () => {
  const onComplete = jest.fn();
  const { container } = render(<Harness onComplete={onComplete} />);
  fireEvent.change(input(), { target: { value: '4a8 2' } });
  expect(input()).toHaveValue('482');
  expect(boxes(container)).toEqual(['4', '8', '2', '—', '—', '—']);
  expect(onComplete).not.toHaveBeenCalled();
  fireEvent.change(input(), { target: { value: '48291355' } });
  expect(input()).toHaveValue('482913');
  expect(onComplete).toHaveBeenCalledWith('482913');
});

it('paste: "482 913" (with a space) lands whole in the six boxes and completes', () => {
  const onComplete = jest.fn();
  const { container } = render(<Harness onComplete={onComplete} />);
  fireEvent.paste(input(), { clipboardData: { getData: () => '482 913' } });
  expect(input()).toHaveValue('482913');
  expect(boxes(container)).toEqual(['4', '8', '2', '9', '1', '3']);
  expect(onComplete).toHaveBeenCalledWith('482913');
});

it('paste of something with no digits changes nothing', () => {
  render(<Harness />);
  fireEvent.paste(input(), { clipboardData: { getData: () => 'hello' } });
  expect(input()).toHaveValue('');
});

it('invalid: aria-invalid + aria-describedby, red boxes, and the wrong code is selected so typing replaces it', () => {
  const { container, rerender } = render(
    <OtpInput value="123456" onChange={jest.fn()} />,
  );
  rerender(
    <OtpInput value="123456" onChange={jest.fn()} invalid describedBy="err" />,
  );
  const el = input();
  expect(el).toHaveAttribute('aria-invalid', 'true');
  expect(el).toHaveAttribute('aria-describedby', 'err');
  expect(container.querySelector('.acs-otp')).toHaveClass('acs-otp--error');
  expect(document.activeElement).toBe(el);
  expect([el.selectionStart, el.selectionEnd]).toEqual([0, 6]);
});

it('keyboard: the active box follows the caret (Arrow/Home/End are the input’s own)', () => {
  const { container } = render(<OtpInput value="4829" onChange={jest.fn()} />);
  const el = input();
  fireEvent.focus(el);
  el.setSelectionRange(1, 1);
  fireEvent.keyUp(el, { key: 'ArrowLeft' });
  expect(container.querySelectorAll('.acs-otp-box')[1]).toHaveClass(
    'acs-otp-box--active',
  );
  el.setSelectionRange(4, 4);
  fireEvent.keyUp(el, { key: 'End' });
  expect(container.querySelectorAll('.acs-otp-box')[4]).toHaveClass(
    'acs-otp-box--active',
  );
});
