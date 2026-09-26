'use client';

import { useEffect, useRef } from 'react';

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));
const DESKTOP = '(min-width: 1024px)';
const POINTER = '(hover: hover) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

/** One-shot entrances; event-driven depth updates. No scroll React state or idle RAF. */
export function useRecruitmentMotion() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = ref.current;
    if (!section) return;
    const stage = section.querySelector<HTMLElement>('[data-story-stage]');
    if (!stage) return;
    const reduced = matchMedia(REDUCED);
    const desktop = matchMedia(DESKTOP);
    const pointer = matchMedia(POINTER);
    const mobile = matchMedia('(max-width: 767px)');
    let revealObserver: IntersectionObserver | undefined;
    let proximityObserver: IntersectionObserver | undefined;
    let near = false;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const update = () => {
      frame = 0;
      if (reduced.matches || !desktop.matches || !near) return;
      const bounds = stage.getBoundingClientRect();
      const progress = clamp(
        (innerHeight - bounds.top) / (innerHeight + bounds.height),
      );
      const exit = clamp(
        (innerHeight * 0.45 - bounds.bottom) / (innerHeight * 0.65),
      );
      stage.style.setProperty('--story-progress', progress.toFixed(4));
      stage.style.setProperty('--story-exit-scale', String(1 - exit * 0.015));
      stage.style.setProperty('--story-exit-opacity', String(1 - exit * 0.06));
      stage.style.setProperty('--story-pointer-x', String(pointerX));
      stage.style.setProperty('--story-pointer-y', String(pointerY));
    };
    const schedule = () => {
      if (!frame && near && !reduced.matches && desktop.matches)
        frame = requestAnimationFrame(update);
    };
    const resetPointer = () => {
      pointerX = 0;
      pointerY = 0;
      stage.style.setProperty('--story-pointer-x', '0');
      stage.style.setProperty('--story-pointer-y', '0');
    };
    const move = (event: PointerEvent) => {
      if (
        reduced.matches ||
        !desktop.matches ||
        !pointer.matches ||
        event.pointerType !== 'mouse'
      )
        return;
      const bounds = stage.getBoundingClientRect();
      pointerX = clamp(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -1,
        1,
      );
      pointerY = clamp(
        ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
        -1,
        1,
      );
      schedule();
    };
    const configure = () => {
      revealObserver?.disconnect();
      proximityObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      resetPointer();
      for (const key of [
        '--story-progress',
        '--story-exit-scale',
        '--story-exit-opacity',
      ])
        stage.style.removeProperty(key);
      const entries = Array.from(
        section.querySelectorAll<HTMLElement>('[data-story-entry]'),
      );
      const targets = mobile.matches
        ? entries
        : entries.filter((node) => !stage.contains(node));
      if (!mobile.matches) targets.push(stage);
      const reveal = (target: HTMLElement) => {
        target.dataset.revealed = 'true';
        if (target === stage)
          entries
            .filter((node) => stage.contains(node))
            .forEach((node) => {
              node.dataset.revealed = 'true';
            });
      };
      if (reduced.matches) {
        entries.forEach(reveal);
        reveal(stage);
        return;
      }
      revealObserver = new IntersectionObserver(
        (items) => {
          items.forEach((item) => {
            if (item.isIntersecting) {
              reveal(item.target as HTMLElement);
              revealObserver?.unobserve(item.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: '0px 0px -24px 0px' },
      );
      targets.forEach((target) => {
        if (
          target.dataset.revealed === 'true' ||
          target.getBoundingClientRect().top < innerHeight - 24
        ) {
          reveal(target);
          return;
        }
        target.dataset.revealed = 'false';
        if (target === stage)
          entries
            .filter(
              (node) =>
                stage.contains(node) && node.dataset.revealed !== 'true',
            )
            .forEach((node) => {
              node.dataset.revealed = 'false';
            });
        revealObserver?.observe(target);
      });
      proximityObserver = new IntersectionObserver(
        (items) => {
          near = items.some((item) => item.isIntersecting);
          if (near) schedule();
        },
        { rootMargin: '150px' },
      );
      proximityObserver.observe(stage);
    };
    configure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    stage.addEventListener('pointermove', move, { passive: true });
    stage.addEventListener('pointerleave', resetPointer);
    [reduced, desktop, pointer, mobile].forEach((query) =>
      query.addEventListener('change', configure),
    );
    return () => {
      revealObserver?.disconnect();
      proximityObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerleave', resetPointer);
      [reduced, desktop, pointer, mobile].forEach((query) =>
        query.removeEventListener('change', configure),
      );
    };
  }, []);
  return ref;
}
