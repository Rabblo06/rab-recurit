import { Suspense, type ComponentProps } from 'react';
import { lazyWithPreload } from '../../shared/lib/lazyWithPreload';

/**
 * `PhoneInput` loaded on demand (fast first navigation, 2026-11-11). `react-phone-number-input` bundles libphonenumber-js
 * (~470 kB before minification); its forms (Create staff, the user detail panel) live in drawers the shell mounts for
 * everyone, so a direct import put the library in every user's first-load bundle. The drawers stay mounted (they open
 * through window events and must not miss one); only the phone field's code waits until a form actually shows it.
 *
 * While it loads (normally already preloaded when the drawer opened), a disabled field of the same size holds its place.
 */
const PhoneInputImpl = lazyWithPreload(() => import('./PhoneInput'));

export const preloadPhoneInput = () => PhoneInputImpl.preload().catch(() => {});

export default function LazyPhoneInput(props: ComponentProps<typeof PhoneInputImpl>) {
  return (
    <Suspense fallback={<input id={props.id} disabled aria-busy="true" aria-label="Phone number (loading)" placeholder={props.placeholder} />}>
      <PhoneInputImpl {...props} />
    </Suspense>
  );
}
