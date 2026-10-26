import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AI_ASSISTANT_COLOURS, AI_ASSISTANT_FACES, AI_ASSISTANT_PRESETS, AI_ASSISTANT_SHAPES } from '@rab/shared';

import AiAssistantAvatar, { AI_AVATAR_SIZES } from './AiAssistantAvatar';
import { AI_AVATAR_STATES } from './faces';
import { shapePath } from './shapes';
import { baseAvatarState } from './useAvatarState';

/**
 * Static guarantees of the ORIGINAL Crewflow avatar (TWENTY_UI_INVENTORY §3, K1–K14):
 *  - no image file is imported or embedded anywhere in the avatar (shapes are computed SVG paths, faces are primitives);
 *  - no Twenty name, preset name or brand appears in the avatar code or the picker;
 *  - every colour pair has face/body contrast ≥ 3:1 in light AND dark (WCAG 1.4.11);
 *  - motion is CSS-only and switched off under prefers-reduced-motion;
 *  - the avatar is always aria-hidden.
 * With AVATAR_GALLERY_OUT set it also writes the TEST-ONLY gallery page the screenshot script captures (28–33); that file
 * is never part of the production bundle.
 */
const DIR = __dirname;
const AVATAR_FILES = readdirSync(DIR).filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.spec.tsx'));
const PICKER = path.resolve(DIR, '../../settings/ai/AiAvatarPicker.tsx');
const read = (f: string) => readFileSync(f, 'utf8');

it('no image file is imported or embedded (no .svg/.png/.jpg/.gif/.webp import, no <image>/<img>, no data: URL)', () => {
  for (const file of [...AVATAR_FILES.map((f) => path.join(DIR, f)), PICKER]) {
    const src = read(file);
    expect({ file, hit: /from\s+['"][^'"]+\.(svg|png|jpe?g|gif|webp|avif)['"]|require\(['"][^'"]+\.(svg|png|jpe?g|gif|webp)/i.test(src) }).toEqual({ file, hit: false });
    expect({ file, hit: /<image\b|<img\b|url\(\s*['"]?data:/i.test(src) }).toEqual({ file, hit: false });
  }
});

it('no Twenty name or preset name appears in the avatar or the picker', () => {
  const banned = /\b(Twenty|Ada|Scout|Nova|Sage|Pixel|Echo|Atlas|Nimbus|Luna|Terra|Astra)\b/;
  for (const file of [...AVATAR_FILES.map((f) => path.join(DIR, f)), PICKER]) expect({ file, match: banned.exec(read(file))?.[0] ?? null }).toEqual({ file, match: null });
  for (const p of Object.values(AI_ASSISTANT_PRESETS)) expect(p.name).not.toMatch(banned);
});

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

it('every colour has a body and a face token in light and dark, with contrast ≥ 3:1', () => {
  const css = read(path.join(DIR, 'avatar.css'));
  const light = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="dark"] {'));
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  for (const [theme, block] of [['light', light], ['dark', dark]] as const) {
    for (const colour of AI_ASSISTANT_COLOURS) {
      const body = new RegExp(`--ai-avatar-${colour}-body:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1];
      const face = new RegExp(`--ai-avatar-${colour}-face:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1];
      expect({ theme, colour, defined: Boolean(body && face) }).toEqual({ theme, colour, defined: true });
      expect(contrast(body!, face!)).toBeGreaterThanOrEqual(3);
    }
  }
});

it('motion is CSS keyframes on transform/opacity only, and none runs under prefers-reduced-motion or animate=false', () => {
  const css = read(path.join(DIR, 'avatar.css'));
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\.ai-av, \.ai-av \* { animation: none !important;/);
  for (const rule of css.match(/\.ai-av\[[^{]*{[^}]*animation:[^}]*}/g) ?? []) expect(rule).toContain('[data-animate="true"]');
  for (const frames of css.match(/@keyframes[^{]+{([^@]*?)}\s*}/g) ?? []) expect(frames.replace(/@keyframes\s+\S+/, '')).not.toMatch(/\b(width|height|left|top|fill|stroke)\s*:/);
});

it('10 shapes × 6 faces × 8 states render as aria-hidden SVG with a computed path', () => {
  for (const shape of AI_ASSISTANT_SHAPES) {
    expect(shapePath(shape)).toMatch(/^M[\d.\s]+.*Z$/);
    for (const face of AI_ASSISTANT_FACES) {
      for (const state of AI_AVATAR_STATES) {
        const { container, unmount } = render(<AiAssistantAvatar look={{ shape, colour: 'orange', face, animate: true }} state={state} size="md" />);
        const root = container.firstElementChild!;
        expect(root.getAttribute('aria-hidden')).toBe('true');
        expect(root.querySelector('svg path.ai-av-body')?.getAttribute('d')).toBe(shapePath(shape));
        unmount();
      }
    }
  }
});

it('CD-12 state table', () => {
  const s = { usable: true, status: null, reasoning: false, toolRunning: false, lastDeltaAt: null } as const;
  expect(baseAvatarState({ ...s, usable: false }, 0)).toBe('sleepy');
  expect(baseAvatarState({ ...s, status: 'queued' }, 0)).toBe('thinking');
  expect(baseAvatarState({ ...s, status: 'running', reasoning: true }, 0)).toBe('thinking');
  expect(baseAvatarState({ ...s, status: 'running', lastDeltaAt: 1_000 }, 1_500)).toBe('talking');
  expect(baseAvatarState({ ...s, status: 'running', lastDeltaAt: 1_000 }, 2_500)).toBe('thinking');
  expect(baseAvatarState({ ...s, status: 'waiting_for_input' }, 0)).toBe('waiting');
  expect(baseAvatarState({ ...s, status: 'failed' }, 0)).toBe('error');
  expect(baseAvatarState({ ...s, status: 'cancelled' }, 0)).toBe('idle');
  expect(baseAvatarState({ ...s, status: 'completed' }, 0)).toBe('idle');
});

/** TEST-ONLY gallery (screenshots 28–33): every state, face, shape, colour and size, written only on request. */
it('writes the avatar gallery page when AVATAR_GALLERY_OUT is set', () => {
  const out = process.env.AVATAR_GALLERY_OUT;
  if (!out) return;
  const css = read(path.join(DIR, 'avatar.css'));
  const look = (over: object = {}) => ({ shape: 'circle' as const, colour: 'orange' as const, face: 'classic' as const, animate: true, ...over });
  const row = (cells: string[]) => `<div class="row">${cells.join('')}</div>`;
  const cell = (el: JSX.Element, label = '') => `<figure>${renderToStaticMarkup(el)}${label ? `<figcaption>${label}</figcaption>` : ''}</figure>`;
  const sizes = Object.keys(AI_AVATAR_SIZES) as Array<keyof typeof AI_AVATAR_SIZES>;
  const sheets = {
    parts: [
      `<h2>Parts · faces and states</h2>`,
      row(AI_ASSISTANT_FACES.map((f) => cell(<AiAssistantAvatar look={look({ face: f })} size="xxl" />, f))),
      row(AI_AVATAR_STATES.map((s) => cell(<AiAssistantAvatar look={look()} state={s} size="xxl" />, s))),
      row(AI_ASSISTANT_SHAPES.map((s) => cell(<AiAssistantAvatar look={look({ shape: s })} size="xxl" />, s))),
    ],
    matrix: [
      `<h2>Colours × states, and three small sizes</h2>`,
      ...AI_ASSISTANT_COLOURS.map((c, i) => row([...AI_AVATAR_STATES.slice(0, 6).map((s) => cell(<AiAssistantAvatar look={look({ colour: c, shape: AI_ASSISTANT_SHAPES[i]! })} state={s} size="xl" />)), ...(['md', 'sm', 'xs'] as const).map((z) => cell(<AiAssistantAvatar look={look({ colour: c, shape: AI_ASSISTANT_SHAPES[i]! })} size={z} />))])),
    ],
    sizes: [
      `<h2>AiAssistantAvatar({shape, colour, face, state, size, animate}) · sizes xs 12 · sm 16 · md 20 · lg 28 · xl 40 · xxl 64</h2>`,
      ...AI_ASSISTANT_COLOURS.map((c) => row(sizes.flatMap((z) => AI_AVATAR_STATES.slice(0, 6).map((s) => cell(<AiAssistantAvatar look={look({ colour: c })} state={s} size={z} />))))),
    ],
  };
  const html = (title: string, body: string[], theme: string) => `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><title>${title}</title><style>${css}
body{margin:0;padding:24px;font:13px Inter,system-ui,sans-serif;background:${theme === 'dark' ? '#1b1c20' : '#ffffff'};color:${theme === 'dark' ? '#ececee' : '#24252b'}}
h2{font-size:15px;font-weight:600;margin:18px 0 10px}.row{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:0 0 12px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:28px}figcaption{font-size:10px;color:#818794}
</style></head><body>${body.join('\n')}</body></html>`;
  for (const theme of ['light', 'dark']) for (const [name, body] of Object.entries(sheets)) writeFileSync(path.join(out, `avatar-${name}-${theme}.html`), html(`Avatar ${name}`, body, theme));
});
