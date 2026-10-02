import RPNInput from 'react-phone-number-input';
import 'react-phone-number-input/style.css';

/**
 * Thin wrapper around `react-phone-number-input` — the flag + dial-code
 * selector the phone screenshot reference asked for, styled to match this
 * app's own `.field input` (thin border, 32px height, no framework look).
 * The library was chosen over hand-rolling a country list: it's the
 * standard, actively-maintained solution for this (bundles
 * `libphonenumber-js`), and no phone-input dependency already existed in
 * `rab-front` to reuse instead.
 *
 * Always stores/emits E.164 (`+447901106232`) — the same format
 * `CreateStaffDto`'s `PHONE_PATTERN` already accepts
 * (`/^[+]?[0-9\s().-]{7,20}$/`), so no backend change is needed. `onChange`
 * receives `undefined` for an empty field; callers normalise that to `''`.
 */
export default function PhoneInput({
  value,
  onChange,
  onBlur,
  placeholder,
  id,
  autoFocus,
  ariaInvalid,
  ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Optional — lets a caller (e.g. Staff Detail's inline hover-to-edit rows) commit on blur, matching every other text-like field's commit model there, instead of on every keystroke. */
  onBlur?: () => void;
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  return (
    <RPNInput
      className="rab-phone-input"
      international
      defaultCountry="GB"
      value={value || undefined}
      onChange={(v) => onChange(v ?? '')}
      placeholder={placeholder ?? 'Enter phone number'}
      numberInputProps={{
        id,
        autoFocus,
        onBlur,
        'aria-invalid': ariaInvalid || undefined,
        'aria-describedby': ariaDescribedBy,
      }}
    />
  );
}
