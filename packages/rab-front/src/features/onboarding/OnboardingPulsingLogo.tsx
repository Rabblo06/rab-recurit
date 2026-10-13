export const LOGO_PULSE_SECONDS = 1;

/**
 * The Crewflow mark, gently pulsing in opacity while `active` (one ~1s ease-in-out leg, then
 * reversed — no scale, bounce or rotation) and settling to full opacity otherwise. A CSS keyframe
 * (`.onboarding-pulsing-logo` in reference-ui.css), not a JS-driven animation: it runs on the
 * compositor and is switched off by `prefers-reduced-motion` in the same stylesheet.
 */
export default function OnboardingPulsingLogo({ active, tone = 'default' }: { active: boolean; tone?: 'default' | 'failed' }) {
  return (
    <div
      className="onboarding-pulsing-logo"
      data-pulsing={active ? 'true' : 'false'}
      style={{
        width: 48,
        height: 48,
        borderRadius: 12,
        background: tone === 'failed' ? 'var(--color-red, #d93025)' : '#5c3e2a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '0 auto 32px',
        animationDuration: `${LOGO_PULSE_SECONDS}s`,
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3L21 19.5H3L12 3Z" fill="white" />
      </svg>
    </div>
  );
}
