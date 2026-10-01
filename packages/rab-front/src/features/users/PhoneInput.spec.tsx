import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhoneInput from './PhoneInput';

function Harness() {
  const [value, setValue] = useState('');
  return (
    <>
      <PhoneInput value={value} onChange={setValue} />
      <span data-testid="stored-value">{value}</span>
    </>
  );
}

describe('PhoneInput (Part 6B, TEST 15)', () => {
  // Defaults to GB per the reference screenshot (🇬🇧 +44), and stores the
  // canonical E.164 form (`+447901106232`) — the same format
  // `CreateStaffDto`'s `PHONE_PATTERN` (`/^[+]?[0-9\s().-]{7,20}$/`) already
  // accepts, so no backend change is needed.
  it('defaults to GB and emits E.164 once a full national number is typed', async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('Enter phone number');
    await userEvent.type(input, '07901106232');
    expect(screen.getByTestId('stored-value').textContent).toBe('+447901106232');
  });

  it('renders a country selector alongside the number input', () => {
    render(<Harness />);
    expect(document.querySelector('.PhoneInputCountry')).toBeTruthy();
    expect(document.querySelector('.PhoneInputCountrySelect')).toBeTruthy();
  });
});
