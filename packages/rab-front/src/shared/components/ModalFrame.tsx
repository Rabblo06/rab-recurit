import { AnimatePresence, motion } from 'framer-motion';
import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { backdrop, modal } from '../motion';

/**
 * The shared `.modal-overlay` / `.modal` pair with Crewflow's modal motion (`shared/motion.ts`): backdrop fades; the
 * dialog fades in with scale 0.97→1 and an 8px rise (260ms), and leaves faster (180ms). While it is leaving it stops
 * receiving pointer events, so a confirm button can never be pressed a second time mid-exit. The look is unchanged
 * (same classes); with reduced motion the app-wide MotionConfig drops the scale/rise and keeps the fade.
 */
export default function ModalFrame({
  open,
  onBackdropMouseDown,
  overlayClassName = '',
  dialogClassName = '',
  dialogProps,
  overlayProps,
  children,
}: {
  open: boolean;
  onBackdropMouseDown?: (e: MouseEvent<HTMLDivElement>) => void;
  overlayClassName?: string;
  dialogClassName?: string;
  dialogProps?: HTMLAttributes<HTMLDivElement> & Record<`aria-${string}` | `data-${string}`, string | boolean | undefined>;
  overlayProps?: Record<`data-${string}`, string>;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`modal-overlay ${overlayClassName}`.trim()}
          {...overlayProps}
          variants={backdrop}
          initial="hidden"
          animate="visible"
          exit="exit"
          onMouseDown={onBackdropMouseDown}
        >
          <motion.div className={`modal ${dialogClassName}`.trim()} {...(dialogProps as object)} variants={modal}>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
