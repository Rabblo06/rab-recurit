import { useEffect, useState } from 'react';
import { AuthMark } from '../auth/AuthLayout';
import { motion } from 'framer-motion';
import { SETUP_STAGES, type SetupStageKey, type SetupStageState } from './setupStages';

/** Scrolls through confirmed steps; the presentation clock never advances past server progress. */
export default function SetupStageList({ stages, reduceMotion }: { stages: Record<SetupStageKey, SetupStageState>; reduceMotion: boolean }) {
  const firstUnfinished = SETUP_STAGES.findIndex(step => stages[step.key] !== 'complete');
  const target = firstUnfinished < 0 ? SETUP_STAGES.length - 1 : firstUnfinished;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (reduceMotion || shown > target) { setShown(target); return; }
    if (shown === target) return;
    const timer = setTimeout(() => setShown(value => Math.min(value + 1, target)), 900);
    return () => clearTimeout(timer);
  }, [shown, target, reduceMotion]);
  return <div className="preparation-compact"><AuthMark /><div className="preparation-window" aria-hidden="true">
    <motion.ol className="preparation-scroll" initial={false} animate={{ y: -Math.max(0, Math.min(shown - 1, SETUP_STAGES.length - 3)) * 28 }} transition={{ duration: reduceMotion ? 0 : .45, ease: [.22, 1, .36, 1] }}>
      {SETUP_STAGES.map(({key, label}, index) => <li key={key} className={'preparation-step' + (index === shown ? ' is-focused' : '')} data-state={stages[key]} data-stage={key}>{label}</li>)}
    </motion.ol>
  </div><span className="preparation-spinner" aria-hidden="true" /></div>;
}
