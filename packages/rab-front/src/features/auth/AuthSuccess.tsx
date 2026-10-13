import { IconCheck } from '@tabler/icons-react';
import { motion, useReducedMotion } from 'framer-motion';
import { s } from './authStyles';
import { staggerContainer, staggerContainerReduced, staggerItem, staggerItemReduced } from '../onboarding/onboardingMotion';

export default function AuthSuccess({ setup = false, loginHref, description, actionLabel = 'Go back to login' }: { setup?: boolean; loginHref?: string; description?: string; actionLabel?: string }) {
  const reduceMotion = useReducedMotion();
  const container = reduceMotion ? staggerContainerReduced : staggerContainer;
  const item = reduceMotion ? staggerItemReduced : staggerItem;
  return (
    <motion.section role="status" aria-live="polite" variants={container} initial="initial" animate="animate" style={{ textAlign: 'center' }}>
      <motion.h1 variants={item} style={s.title}>{setup ? 'Your account setup is complete' : 'Password updated'}</motion.h1>
      <motion.p variants={item} style={s.subtitle}>{description || 'You’re all set. Sign in with your new password.'}</motion.p>
      <motion.div variants={item}>
        {loginHref ? <a href={loginHref} style={s.submitBtn}>{actionLabel}</a> : <p style={s.subtitle}>{actionLabel}</p>}
      </motion.div>
    </motion.section>
  );
}
