import { animate } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { duration, usePrefersReducedMotion } from '../motion';

/** Decelerating, non-overshooting count easing (cubic ease-out) — values never pass their target. */
export const COUNT_EASE: [number, number, number, number] = [0.33, 1, 0.68, 1];
/** Initial reveal of a dashboard figure: long enough to SEE it count up and slow into place. */
export const REVEAL_S = 1.3;

/**
 * A number that visibly moves to its REAL value.
 * - `reveal`: on mount it starts at 0 and counts up to the value (call it only once a real value exists — a loading,
 *   unavailable or failed metric must render its own "–" instead of this component, so null is never shown as 0).
 *   Without `reveal` the first value renders as-is (pipeline lanes, review scores, bulk counts keep that behaviour).
 * - Later changes tween from the CURRENTLY DISPLAYED value (never back to 0); a newer target mid-flight retargets from
 *   where it is and the obsolete animation is stopped (its completion never fires). Unchanged values do nothing.
 * - `format` keeps integers whole / decimals fixed / units stable on every frame; tabular figures and a min-width of
 *   the final text keep the layout still. The authoritative value is `data-value` and the text assistive technology
 *   reads; the interpolated frames are aria-hidden.
 * - Reduced motion: the final value, immediately. Hidden tab mid-animation: time-based, so it lands on the target.
 */
export default function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString('en-GB'),
  className,
  durationS = duration.kpi,
  reveal = false,
  revealDurationS = REVEAL_S,
  delayS = 0,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
  /** Duration for changes after the first value. */
  durationS?: number;
  reveal?: boolean;
  revealDurationS?: number;
  /** Small delay before the reveal only (choreography); never applied to later updates. */
  delayS?: number;
}) {
  const reduce = usePrefersReducedMotion();
  const current = useRef(reveal && !reduce ? 0 : value);
  const revealPending = useRef(reveal && !reduce);
  const [shown, setShown] = useState(current.current);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (reduce || current.current === value) {
      current.current = value;
      revealPending.current = false;
      setShown(value);
      setAnimating(false);
      return;
    }
    const isReveal = revealPending.current;
    setAnimating(true);
    const controls = animate(current.current, value, {
      duration: isReveal ? revealDurationS : durationS,
      delay: isReveal ? delayS : 0,
      ease: COUNT_EASE,
      onUpdate: (v) => { current.current = v; setShown(v); },
      onComplete: () => {
        current.current = value;
        revealPending.current = false;
        setShown(value);
        setAnimating(false);
      },
    });
    // Stopping (unmount, newer target, Strict Mode's effect re-run) never calls onComplete: the next run continues from
    // the displayed value, and a reveal that was interrupted is still a reveal.
    return () => controls.stop();
  }, [value, reduce]); // eslint-disable-line react-hooks/exhaustive-deps

  const finalText = format(value);
  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-block', minWidth: `${finalText.length}ch` }} data-value={value}>
      {animating
        ? <><span aria-hidden="true" data-animating="true">{format(shown)}</span><span className="visually-hidden">{finalText}</span></>
        : format(shown)}
    </span>
  );
}
