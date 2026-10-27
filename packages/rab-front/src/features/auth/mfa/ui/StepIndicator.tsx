const STEPS = ['Confirm identity', 'Connect app', 'Save codes'] as const;

/** The design's `steps(n)`: three labelled bars; bars up to `current` are orange, the current label is bold. */
export default function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="acs-steps" aria-label="Setup progress">
      {STEPS.map((label, i) => {
        const n = i + 1;
        return (
          <li
            key={label}
            className={`acs-step${n <= current ? ' acs-step--active' : ''}${n === current ? ' acs-step--current' : ''}`}
            aria-current={n === current ? 'step' : undefined}
          >
            <span className="acs-visually-hidden">
              Step {n} of {STEPS.length}:{' '}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
