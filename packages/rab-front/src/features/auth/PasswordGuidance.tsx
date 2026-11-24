import { checkPasswordStrength, generateSecurePassword, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { IconCheck, IconMinus } from '@tabler/icons-react';
import './password-guidance.css';

/** Live guidance only: submission still uses the shared server password policy. */
export default function PasswordGuidance({ id, password, email, disabled, onSuggest }: {
  id: string; password: string; email?: string; disabled?: boolean; onSuggest: (value: string) => void;
}) {
  const result = checkPasswordStrength(password, email);
  const rules = [
    { label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: password.length >= MIN_PASSWORD_LENGTH },
    { label: 'Upper and lowercase letters', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { label: 'At least one number', met: /[0-9]/.test(password) },
    { label: 'A symbol (recommended)', met: /[^a-zA-Z0-9\s]/.test(password) },
  ];
  const strong = result.valid && password.length >= 12 && rules[3].met;
  const score = !password ? 0 : strong ? 4 : result.valid ? 3 : Math.min(2, rules.filter(r => r.met).length);
  const label = !password ? 'Enter a password' : strong ? 'Strong' : result.valid ? 'Meets requirements' : 'Needs improvement';
  return <div className="password-guidance">
    <div className="password-guidance-meter" role="meter" aria-label="Password strength" aria-valuemin={0} aria-valuemax={4} aria-valuenow={score} aria-valuetext={label}>
      <span className="password-guidance-bars" aria-hidden="true">{[1,2,3,4].map(n => <i key={n} data-filled={n <= score} data-valid={result.valid} />)}</span>
      <span>{label}</span>
    </div>
    <ul id={id} aria-label="Password requirements">{rules.map(rule => <li key={rule.label}>
      <span className="password-guidance-check" data-met={rule.met} aria-hidden="true">{rule.met ? <IconCheck size={12} /> : <IconMinus size={12} />}</span>
      <span><span className="password-guidance-sr">{rule.met ? 'Met: ' : 'Not met: '}</span>{rule.label}</span>
    </li>)}</ul>
    {password && !result.valid && <ul className="password-guidance-errors" aria-label="Additional password guidance">{result.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    <button className="password-guidance-suggest" type="button" disabled={disabled} onClick={() => onSuggest(generateSecurePassword())}>Suggest one</button>
  </div>;
}
