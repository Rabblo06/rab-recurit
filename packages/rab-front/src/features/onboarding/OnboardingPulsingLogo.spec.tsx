import { render } from '@testing-library/react';
import OnboardingPulsingLogo, { LOGO_PULSE_SECONDS } from './OnboardingPulsingLogo';

function logo() {
  return document.querySelector<HTMLElement>('.onboarding-pulsing-logo')!;
}

// The keyframe itself and its reduced-motion switch-off live in reference-ui.css; jsdom does not
// run CSS animations, so this only covers the component's contract with that stylesheet.
it('opts into the pulse while active, on a ~1s rhythm inside the requested 0.8–1.2s band', () => {
  render(<OnboardingPulsingLogo active />);
  expect(logo().getAttribute('data-pulsing')).toBe('true');
  expect(logo().style.animationDuration).toBe(`${LOGO_PULSE_SECONDS}s`);
  expect(LOGO_PULSE_SECONDS).toBeGreaterThanOrEqual(0.8);
  expect(LOGO_PULSE_SECONDS).toBeLessThanOrEqual(1.2);
});

it('settles when inactive', () => {
  render(<OnboardingPulsingLogo active={false} />);
  expect(logo().getAttribute('data-pulsing')).toBe('false');
});
