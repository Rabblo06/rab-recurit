'use client';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
export function MotionReveal({
  children,
  className,
  flow = false,
}: {
  children: React.ReactNode;
  className?: string;
  flow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let observer: IntersectionObserver | undefined;
    const setup = () => {
      observer?.disconnect();
      if (preference.matches) {
        node.dataset.visible = 'true';
        return;
      }
      // Above-the-fold and no-JS content stays visible. Only prepare below-fold reveals.
      if (node.getBoundingClientRect().top > window.innerHeight)
        node.dataset.visible = 'false';
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            node.dataset.visible = 'true';
            observer?.disconnect();
          }
        },
        { threshold: 0.16 },
      );
      observer.observe(node);
    };
    setup();
    preference.addEventListener('change', setup);
    return () => {
      observer?.disconnect();
      preference.removeEventListener('change', setup);
    };
  }, []);
  return (
    <div ref={ref} className={cn('reveal', flow && 'flow-reveal', className)}>
      {children}
    </div>
  );
}
export function SectionHeading({
  eyebrow,
  children,
  description,
}: {
  eyebrow: string;
  children: React.ReactNode;
  description?: string;
}) {
  return (
    <div className="section-heading">
      <p className="eyebrow">
        <span className="tiny-line" />
        {eyebrow}
      </p>
      <h2>{children}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
  );
}
