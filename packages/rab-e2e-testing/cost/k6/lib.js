// k6 helpers for the D-Q6 realistic journeys (journeys.js, main.js). Runs INSIDE the pinned grafana/k6 image on
// crewflow-cost-net, never against anything but the disposable harness API.
//
// Adapted from templates/lib.js of github.com/arjaythedev/realistic-load-test @ 8eb3343b (MIT): env helpers, think(),
// pickWeighted() and the per-endpoint summary idea. Changes: a seeded PRNG instead of Math.random (identical traffic shape
// in every arm), a window tag instead of the staircase stepper, and the harness result format (one K6P_RESULT line).
//
// MIT License, Copyright (c) 2026 Arjay McCandless. Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions: The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
// AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { sleep } from 'k6';

export function env(name, fallback) {
  const v = __ENV[name];
  return v === undefined || v === '' ? fallback : v;
}
export function envNum(name, fallback) {
  const v = env(name, undefined);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

// mulberry32, one stream per VU (seeded from K6P_SEED and the VU number), so every arm replays the same choices and
// pauses. Math.random is never used.
let rngState = 0;
export function seedVu(seed, vu) { rngState = (Number(seed) + vu * 7919) >>> 0; }
export function rand() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const between = (min, max) => min + rand() * (max - min);
export const chance = (p) => rand() < p;
export const pickOne = (a) => a[Math.floor(rand() * a.length)];

/** One of [{weight, ...}] with probability proportional to weight. */
export function pickWeighted(items) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let x = rand() * total;
  for (const it of items) if ((x -= it.weight) < 0) return it;
  return items[items.length - 1];
}

/** A human pause: a uniform random time in [min, max] seconds. Every pause in journeys.js goes through this. */
export function think(min, max) { sleep(between(min, max)); }

/** Jittered interval as the C1 clients compute it: base ±20 % (shared/lib/polling.ts, poll_scheduler.dart). */
export const jitter = (baseS, pct = 0.2) => baseS * (1 + (rand() * 2 - 1) * pct);

export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
// No `url` tag: one series per id would exhaust memory. `name`, `journey` and `win` group requests.
export const SYSTEM_TAGS = ['status', 'method', 'name', 'group', 'check', 'error', 'error_code', 'scenario', 'expected_response'];
