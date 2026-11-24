import { useId, useState } from 'react';
import { IconListDetails, IconWorldOff } from '@tabler/icons-react';
import './name-input.css';
import StaffSelect from './StaffSelect';
import flags from 'react-phone-number-input/flags';
import { getCountries } from 'react-phone-number-input';
import countryNames from 'react-phone-number-input/locale/en.json';
type Address = { address: string; address2: string; city: string; state: string; postcode: string; country: string };
const countries = getCountries().map(code => {
  const Flag = flags[code];
  return { value: countryNames[code], label: countryNames[code], icon: Flag ? <span className="staff-country-flag" aria-hidden="true"><Flag title={countryNames[code]} /></span> : undefined };
}).sort((a, b) => a.label.localeCompare(b.label));
export default function AddressInput({ onChange, ...value }: Address & { onChange: (value: Address) => void }) {
  const { address, address2 = '', city, state = '', postcode, country = '' } = value;
  const update = (key: keyof Address, text: string) => onChange({ ...value, [key]: text });
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  return <div className="field person-name-field">
    <label htmlFor={id}>Address</label>
    <div className="person-name-control">
      <div className="person-name-main">
        <input id={id} autoComplete="address-line1" placeholder="Street address" value={address}
          onChange={event => update('address', event.target.value)} />
        <button type="button" aria-label={expanded ? 'Collapse address fields' : 'Expand address fields'} aria-expanded={expanded}
          aria-controls={id + '-parts'} onClick={() => setExpanded(!expanded)}><IconListDetails size={16} aria-hidden="true" /></button>
      </div>
      <div id={id + '-parts'} className="person-name-parts" hidden={!expanded}>
        <div style={{ gridColumn: '1 / -1' }}><label htmlFor={id + '-line2'}>Address 2</label><input id={id + '-line2'} autoComplete="address-line2" placeholder="Street address 2" value={address2} onChange={event => update('address2', event.target.value)} /></div>
        <div><label htmlFor={id + '-city'}>City</label>
          <input id={id + '-city'} autoComplete="address-level2" value={city} onChange={event => update('city', event.target.value)} /></div>
        <div><label htmlFor={id + '-state'}>State</label><input id={id + '-state'} autoComplete="address-level1" value={state} onChange={event => update('state', event.target.value)} /></div>
        <div><label htmlFor={id + '-postcode'}>Postcode</label>
          <input id={id + '-postcode'} autoComplete="postal-code" value={postcode} onChange={event => update('postcode', event.target.value)} /></div>
        <div><label htmlFor={id + '-country'}>Country</label><StaffSelect id={id + '-country'} label="Country" compact value={country} onChange={value => update('country', value)} placeholder="No country" options={[{ value: '', label: 'No country', icon: <IconWorldOff size={14} aria-hidden="true" /> }, ...countries]} /></div>
      </div>
    </div>
  </div>;
}
