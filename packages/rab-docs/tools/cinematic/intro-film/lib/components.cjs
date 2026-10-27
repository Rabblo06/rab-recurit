// Reusable visual components for the introduction film (HTML strings + CSS), shared by the proof and the full film so
// the two cannot drift apart. Every animation is added by the caller to ONE paused GSAP timeline (deterministic).
'use strict';

const C = { white: '#FFFFFF', grey: '#F8F8F9', charcoal: '#24252B', mid: '#646873', orange: '#FF7A1A', orange2: '#FFA31A', border: '#E5E7EB', orangeText: '#B4520A' }; // orangeText: brand orange darkened for small text contrast (≥4.5:1 on white)
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Geometry (output px)
const G = {
  W: 1920, H: 1080,
  content: { y0: 24, y1: 964 },
  capBand: { y0: 972, y1: 1064 },
  stageFull: { x: 128, y: 28, w: 1664, h: 936 },
  stageSplit: { x: 72, y: 184, w: 1060, h: 596 },
  phone: { screenW: 406, screenH: 880, bezel: 12 },
};

const css = `
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-400-normal.woff2") format("woff2"); font-weight: 400; }
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-500-normal.woff2") format("woff2"); font-weight: 500; }
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-600-normal.woff2") format("woff2"); font-weight: 600; }
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-700-normal.woff2") format("woff2"); font-weight: 700; }
  body { margin: 0; background: ${C.grey}; font-family: "Inter", sans-serif; color: ${C.charcoal}; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${C.grey}; }
  .layer { position: absolute; inset: 0; }
  .surface-white { background: ${C.white}; }
  .surface-grid { background-color: ${C.grey}; background-image: radial-gradient(${C.border} 1.6px, transparent 1.7px); background-size: 24px 24px; }
  .diagram-tag { position: absolute; font-size: 14px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: ${C.mid}; }

  /* Web stage: real footage in a window; the camera is a transform inside the clip. */
  .stage { position: absolute; border-radius: 16px; overflow: hidden; background: ${C.white}; border: 1px solid ${C.border}; box-shadow: 0 24px 60px rgba(36,37,43,.12), 0 2px 8px rgba(36,37,43,.06); }
  .stage .cam { position: absolute; left: 0; top: 0; width: 3200px; height: 1800px; transform-origin: 0 0; }
  .stage video { position: absolute; left: 0; top: 0; width: 3200px; height: 1800px; }

  /* Device frame: generic rounded body, portrait footage contain-fitted (never stretched). */
  .phone { position: absolute; width: ${G.phone.screenW + 2 * G.phone.bezel}px; height: ${G.phone.screenH + 2 * G.phone.bezel}px; border-radius: 44px; background: #15161a; box-shadow: 0 30px 70px rgba(36,37,43,.22); }
  .phone .screen { position: absolute; left: ${G.phone.bezel}px; top: ${G.phone.bezel}px; width: ${G.phone.screenW}px; height: ${G.phone.screenH}px; border-radius: 34px; overflow: hidden; background: #000; }
  .phone video { position: absolute; left: 0; top: 0; width: ${G.phone.screenW}px; height: ${G.phone.screenH}px; object-fit: contain; }

  .role-node { position: absolute; width: 300px; text-align: center; }
  .role-node .dot { width: 96px; height: 96px; margin: 0 auto 18px; border-radius: 50%; background: ${C.white}; border: 2px solid ${C.border}; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(36,37,43,.08); }
  .role-node .dot svg { width: 44px; height: 44px; }
  .role-node .name { font-size: 30px; font-weight: 700; }
  .role-node .q { margin-top: 8px; font-size: 22px; font-weight: 500; color: ${C.mid}; }

  .strip { position: absolute; display: flex; align-items: center; gap: 18px; }
  .strip .step { padding: 14px 26px; border-radius: 999px; border: 2px solid ${C.border}; background: ${C.white}; font-size: 28px; font-weight: 600; color: ${C.mid}; }
  .strip .arrow { width: 34px; height: 2px; background: ${C.border}; }
  .strip .step.final { border-color: ${C.charcoal}; }

  .chapter-card { position: absolute; inset: 0; background: ${C.grey}; }
  .chapter-card .inner { position: absolute; left: 128px; top: 430px; }
  .chapter-card .num { font-size: 22px; font-weight: 600; letter-spacing: .12em; color: ${C.orangeText}; }
  .chapter-card .rule { width: 64px; height: 4px; background: ${C.orange}; margin: 18px 0 22px; border-radius: 2px; }
  .chapter-card .title { font-size: 64px; font-weight: 700; letter-spacing: -.015em; color: ${C.charcoal}; }
  .chapter-pill { position: absolute; padding: 9px 18px; border-radius: 999px; background: ${C.white}; border: 1px solid ${C.border}; font-size: 18px; font-weight: 600; color: ${C.charcoal}; box-shadow: 0 4px 14px rgba(36,37,43,.06); }
  .chapter-pill::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${C.orange}; margin-right: 10px; vertical-align: 2px; }

  .shift-card { position: absolute; width: 520px; padding: 28px 30px; border-radius: 20px; background: ${C.white}; border: 1px solid ${C.border}; box-shadow: 0 18px 48px rgba(36,37,43,.10); }
  .shift-card .eyebrow { font-size: 16px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: ${C.orangeText}; }
  .shift-card .head { margin-top: 10px; font-size: 30px; font-weight: 700; }
  .shift-card .sub { margin-top: 4px; font-size: 20px; color: ${C.mid}; }
  .shift-card .rows { margin-top: 18px; border-top: 1px solid ${C.border}; }
  .shift-card .row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid ${C.border}; font-size: 20px; }
  .shift-card .row b { font-weight: 600; }
  .shift-card .row span { color: ${C.mid}; }
  .avatars { display: flex; gap: 8px; }
  .avatars i { width: 34px; height: 34px; border-radius: 50%; background: ${C.grey}; border: 1px solid ${C.border}; font-style: normal; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: center; color: ${C.charcoal}; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; font-size: 18px; font-weight: 600; }
  .chip.pending { border: 2px solid #c9ccd3; color: ${C.mid}; background: ${C.white}; }
  .chip.offered { border: 2px solid ${C.orange2}; color: #b4590b; background: ${C.white}; }
  .chip.confirmed { background: ${C.orange}; color: ${C.charcoal}; border: 2px solid ${C.orange}; }
  .state-slot { margin-top: 18px; height: 42px; position: relative; }
  .state-slot .chip { position: absolute; left: 0; top: 0; }

  .flow { position: absolute; display: flex; align-items: center; gap: 16px; font-size: 19px; font-weight: 600; }
  .flow .n { display: flex; align-items: center; gap: 8px; }
  .flow .n i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid ${C.mid}; display: inline-block; }
  .flow .n.lit i { background: ${C.orange}; border-color: ${C.orange}; }
  .flow .n.dim { color: ${C.mid}; }
  .flow .n.dim i { border-color: #c9ccd3; border-style: dashed; }
  .flow .l { width: 46px; height: 2px; background: ${C.orange}; }
  .flow .l.dash { background: repeating-linear-gradient(90deg, #c9ccd3 0 6px, transparent 6px 12px); }

  .kinetic { position: absolute; padding: 12px 22px; border-radius: 14px; background: ${C.charcoal}; color: ${C.white}; font-size: 28px; font-weight: 700; letter-spacing: -.01em; }
  .kinetic::after { content: ""; position: absolute; left: 22px; right: 22px; bottom: 9px; height: 3px; border-radius: 2px; background: ${C.orange}; transform-origin: 0 50%; transform: scaleX(var(--u, 0)); }
  .row-highlight { position: absolute; border: 3px solid ${C.orange}; border-radius: 10px; box-shadow: 0 0 0 6px rgba(255,122,26,.18); }
  .tap-ring { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%; border: 3px solid ${C.orange}; }

  #captions { position: absolute; left: 0; right: 0; top: ${G.capBand.y0}px; height: ${G.capBand.y1 - G.capBand.y0}px; }
  .cap { position: absolute; left: 0; right: 0; top: 0; margin: 0 auto; width: fit-content; max-width: 1200px; text-align: center; font-size: 30px; font-weight: 500; line-height: 1.3; color: ${C.charcoal}; white-space: pre-line; }
  .logo-lock { position: absolute; left: 50%; top: 420px; transform: translateX(-50%); text-align: center; }
  .logo-lock img { width: 556px; height: 128px; display: block; margin: 0 auto; }
  .logo-lock .tag { margin-top: 26px; font-size: 28px; font-weight: 500; color: ${C.mid}; }
`;

const ICON = {
  venue: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.charcoal}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6"/></svg>`,
  manager: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.charcoal}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  staff: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.charcoal}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${C.charcoal}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
};

const roleNode = (id, x, y, icon, name, q) => `<div id="${id}" class="role-node" style="left:${x - 150}px;top:${y}px"><div class="dot">${ICON[icon]}</div><div class="name">${esc(name)}</div><div class="q">${esc(q)}</div></div>`;
const chip = (kind, text, id = '') => `<span ${id ? `id="${id}" ` : ''}class="chip ${kind}">${kind === 'confirmed' ? ICON.check : ''}${esc(text)}</span>`;
const phone = (id, x, y, videos) => `<div id="${id}" class="phone" style="left:${x}px;top:${y}px"><div class="screen">${videos}</div></div>`;
const chapterCard = (id, n, title) => `<div id="${id}" class="chapter-card"><div class="inner"><div class="num">${String(n).padStart(2, '0')}</div><div class="rule"></div><div class="title">${esc(title)}</div></div></div>`;

// Web camera: rect (in 3200×1800 footage px) at film time t, from keyframes [{t, d, r}] — each move starts from wherever
// the camera actually is (no jumps), eased in-out, zoom interpolated on a log scale.
const cameraRuntime = `
  const easeIO = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  function camLerp(a, b, t0, d, t) {
    const e = easeIO(d > 0 ? Math.min(1, Math.max(0, (t - t0) / d)) : 1);
    const w = Math.exp(Math.log(a.w) + (Math.log(b.w) - Math.log(a.w)) * e);
    const cx = a.x + a.w / 2 + (b.x + b.w / 2 - a.x - a.w / 2) * e, cy = a.y + a.h / 2 + (b.y + b.h / 2 - a.y - a.h / 2) * e;
    return { x: cx - w / 2, y: cy - (w * 9 / 16) / 2, w, h: w * 9 / 16 };
  }
  function camAt(keys, t) {
    let seg = null;
    for (let i = 1; i < keys.length; i++) { const k = keys[i]; if (t < k.t) break; const from = seg ? camLerp(seg.a, seg.b, seg.t0, seg.d, k.t) : keys[0].r; seg = { a: from, b: k.r, t0: k.t, d: k.d }; }
    return seg ? camLerp(seg.a, seg.b, seg.t0, seg.d, t) : keys[0].r;
  }
`;

/** Focus rect (footage px) around CSS-px boxes, 16:9, margins, zoom ceiling, clamped to the frame. */
function focusRect(boxes, { dpr = 2, FW = 3200, FH = 1800, marginRatio = 0.12, maxZoom = 1.65 } = {}) {
  const bs = boxes.map((b) => ({ x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr }));
  let x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  let x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  const mx = Math.max(80, (x1 - x0) * marginRatio), my = Math.max(80, (y1 - y0) * marginRatio);
  x0 -= mx; x1 += mx; y0 -= my; y1 += my;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < 16 / 9) w = h * 16 / 9; else h = w * 9 / 16;
  w = Math.min(Math.max(w, FW / maxZoom), FW); h = w * 9 / 16;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const x = Math.min(Math.max(0, cx - w / 2), FW - w), y = Math.min(Math.max(0, cy - h / 2), FH - h);
  const r = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  for (const b of bs) if (b.x < r.x || b.y < r.y || b.x + b.w > r.x + r.w || b.y + b.h > r.y + r.h) throw new Error('focus box would be cropped');
  return r;
}

/** Caption chunks: ≤42 chars per line, ≤2 lines, timed by character share of the spoken segment. */
function captionChunks(text, start, seconds) {
  const words = text.split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > 42 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  const groups = []; for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2).join('\n'));
  const total = groups.reduce((a, g) => a + g.length, 0); let at = start;
  return groups.map((g) => { const d = seconds * (g.length / total); const c = { start: +at.toFixed(3), end: +(at + d).toFixed(3), text: g }; at += d; return c; });
}

module.exports = { C, G, css, esc, ICON, roleNode, chip, phone, chapterCard, cameraRuntime, focusRect, captionChunks };
