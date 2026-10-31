// Screen-traffic engine: replays a client screen's request schedule (from a schedule file, schedules/*.mjs) for one
// synthetic user against the disposable crewflow-cost API, and records every request it sends.
//
// A schedule describes WHAT a screen requests and WHEN (timers, intervals, jitter, overlap policy, visibility gating,
// headers, backoff); this file only interprets it. The "after" measurement swaps the schedule file, never this engine.
// Step and timer vocabulary: see ../README.md "Schedule format".
//
// Safety: requests go only to the API base given by the caller (run-load.mjs refuses anything but the harness API on
// 127.0.0.1:<COST_API_PORT>). Credentials are the harness seed password, read by the caller; nothing is printed.

// mulberry32: deterministic jitter (same seed -> same tick offsets in the before and after runs).
export function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class HttpError extends Error {
  constructor(status, retryAfter) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Route template for reporting: ids and query values are collapsed so requests group by endpoint.
export function routeOf(method, path) {
  const [p, q] = path.split('?');
  const tpl = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
  const keys = q ? new URLSearchParams(q) : null;
  const shown = keys ? [...keys.entries()].filter(([k]) => !['page'].includes(k)).map(([k, v]) => (['view', 'bucket', 'status', 'state', 'range', 'limit', 'includeArchived'].includes(k) ? `${k}=${v}` : k)) : [];
  return `${method} ${tpl}${shown.length ? `?${shown.join('&')}` : ''}`;
}

// Named derivations a schedule may reference with { derive: '<name>' }: request sequences that depend on a previous
// response exactly the way the client code computes them.
const DERIVE = {
  // rab-front VenueOfferPipeline.tsx (614796f0, lines ~276-305): sorted unique avatarFileIds of pipeline.staff and
  // pipeline.report.staff, POST /files/previews in chunks of 32, sequentially. No request when the list is empty.
  async webPipelineAvatarPreviews(ctx, step, run) {
    const p = ctx.captures.pipeline;
    if (!p) return;
    const ids = [...new Set([...(p.staff ?? []).map((r) => r.avatarFileId), ...(p.report?.staff ?? []).map((r) => r.avatarFileId)].filter(Boolean))].sort();
    for (let i = 0; i < ids.length; i += 32) await run.request(ctx, 'POST', '/files/previews', { fileIds: ids.slice(i, i + 32) }, step);
  },
  // rab-front HealthTab.tsx: the jobs/metrics queries use the queue named 'rab-email' if present, else the first queue.
  adminQueueName(ctx) {
    const qs = ctx.captures.adminQueues?.queues ?? [];
    return (qs.find((q) => q.name === 'rab-email') ?? qs[0])?.name;
  },
};

function expand(path, ctx) {
  return path.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 'todayUtc') return new Date().toISOString().slice(0, 10); // rab-front AiAdminSections utcDay()
    if (k === 'adminQueue') return encodeURIComponent(DERIVE.adminQueueName(ctx) ?? 'rab-email');
    const v = ctx.params[k];
    if (v === undefined) throw new Error(`schedule placeholder {${k}} has no value for ${ctx.user}`);
    return encodeURIComponent(v);
  });
}

/**
 * One user running one screen. `transport(ctx, method, path, body, meta)` performs the HTTP call and returns
 * { status, json, retryAfter }; the Runner wraps it with dedupe, error semantics and recording.
 */
export class ScreenRunner {
  constructor({ user, screenId, screen, params, transport, record, seed, now = () => Date.now() }) {
    this.ctx = { user, screenId, params: params ?? {}, captures: {}, hidden: false, startedAt: now(), lastInputAt: now() };
    this.screen = screen;
    this.transport = transport;
    this.record = record;
    this.rand = prng(seed);
    this.now = now;
    this.inflight = new Map(); // dedupe key -> promise
    this.timerState = new Map();
    this.abort = new AbortController();
  }

  backgroundHeaderFor(timer) {
    const mode = timer?.backgroundHeader ?? this.screen.backgroundHeader ?? 'never';
    if (mode === true || mode === 'always') return true;
    if (mode === 'after-idle-60s') return this.now() - this.ctx.lastInputAt > 60_000; // rab-front user-activity.ts
    return false;
  }

  async request(ctx, method, path, body, step, timer) {
    const key = step?.dedupe;
    if (key && this.inflight.has(key)) {
      this.record({ user: ctx.user, screen: ctx.screenId, timer: timer?.name ?? step?._timer ?? 'start', method, route: routeOf(method, path), joined: true, t0: this.now() });
      return this.inflight.get(key);
    }
    const p = (async () => {
      const res = await this.transport(ctx, method, expand(path, ctx), body, { background: this.backgroundHeaderFor(timer), timer: timer?.name ?? 'start', signal: step?._signal });
      if (res.status >= 400 || res.status === 0) throw new HttpError(res.status, res.retryAfter);
      if (step?.capture) ctx.captures[step.capture] = res.json;
      return res.json;
    })();
    if (key) {
      this.inflight.set(key, p);
      p.catch(() => {}).finally(() => this.inflight.get(key) === p && this.inflight.delete(key));
    }
    return p;
  }

  async runSteps(steps, timer, signal) {
    for (const step of steps) await this.runStep(step, timer, signal);
  }

  async runStep(step, timer, signal) {
    const ctx = this.ctx;
    const s = { ...step, _signal: signal };
    if (step.get) return this.request(ctx, 'GET', step.get, undefined, s, timer);
    if (step.post) return this.request(ctx, 'POST', step.post, step.body ?? {}, s, timer);
    if (step.pageAll) {
      // Flutter VenueManagerProvider.all() / iOS VenueManagerRepository.all(): page=N&limit=L from 1 until a plain
      // array or until the accumulated rows reach `total`; an empty page before that is an error.
      const lim = step.limit ?? 100;
      let n = 0;
      for (let page = 1; page <= 1000; page++) {
        const sep = step.pageAll.includes('?') ? '&' : '?';
        const r = await this.request(ctx, 'GET', `${step.pageAll}${sep}page=${page}&limit=${lim}`, undefined, s, timer);
        if (Array.isArray(r)) return;
        const rows = r?.data ?? [];
        n += rows.length;
        if (n >= Number(r?.total ?? 0)) return;
        if (!rows.length) throw new Error('list changed while paging');
      }
      return;
    }
    if (step.keysetAll) {
      // Phase C1 keyset paging (Flutter core/polling/keyset_pages.dart, iOS Core/Polling/KeysetPaging.swift):
      // ?<query>&limit=L[&cursor=C] until `nextCursor` is null; a bare array ends it. `dedupe` joins the WHOLE walk
      // already in flight for this user (Flutter OffersProvider joinInFlight / single flight).
      const key = step.dedupe ? `walk:${step.dedupe}` : null;
      if (key && this.inflight.has(key)) {
        this.record({ user: ctx.user, screen: ctx.screenId, timer: timer?.name ?? 'start', method: 'GET', route: routeOf('GET', `${step.keysetAll}?${step.query ?? ''}`), joined: true, t0: this.now() });
        return this.inflight.get(key);
      }
      const walk = (async () => {
        let cursor = null;
        for (let page = 0; page < 100; page++) {
          const q = [step.query, `limit=${step.limit}`, cursor ? `cursor=${encodeURIComponent(cursor)}` : null].filter(Boolean).join('&');
          const r = await this.request(ctx, 'GET', `${step.keysetAll}?${q}`, undefined, { ...s, dedupe: undefined }, timer);
          if (Array.isArray(r) || !r?.nextCursor) return r;
          cursor = r.nextCursor;
        }
      })();
      if (key) {
        this.inflight.set(key, walk);
        walk.catch(() => {}).finally(() => this.inflight.get(key) === walk && this.inflight.delete(key));
      }
      return walk;
    }
    if (step.parallel) {
      if (step.onError === 'cancel-others') {
        const ac = new AbortController();
        const sig = AbortSignal.any([ac.signal, ...(signal ? [signal] : [])]);
        try {
          await Promise.all(step.parallel.map((x) => this.runStep(x, timer, sig).catch((e) => { ac.abort(); throw e; })));
        } finally { /* siblings were aborted on the first error */ }
        return;
      }
      const res = await Promise.allSettled(step.parallel.map((x) => this.runStep(x, timer, signal)));
      const bad = res.find((r) => r.status === 'rejected');
      if (bad) throw bad.reason;
      return;
    }
    if (step.seq) return this.runSteps(step.seq, timer, signal);
    if (step.ifCap) {
      const caps = ctx.captures[step.from ?? 'caps'] ?? {};
      if (caps[step.ifCap] === true) {
        if (step.swallow) { try { await this.runSteps(step.steps, timer, signal); } catch { /* client ignores */ } return; }
        return this.runSteps(step.steps, timer, signal);
      }
      return;
    }
    if (step.derive) return DERIVE[step.derive](ctx, s, { request: (c, m, p, b, st) => this.request(c, m, p, b, st, timer) });
    if (step.swallowAll) { try { await this.runSteps(step.swallowAll, timer, signal); } catch { /* best effort */ } return; }
    throw new Error(`unknown step ${JSON.stringify(step)}`);
  }

  // One execution of a timer's steps, with the timer's error/backoff policy. Returns the delay override (ms) or null.
  async fire(timer) {
    const st = this.timerState.get(timer.name);
    st.running++;
    const overlap = st.running - 1;
    if (overlap > 0) st.overlaps++;
    st.runs++;
    let next = null;
    try {
      await this.runSteps(timer.steps, timer, this.abort.signal);
      st.failures = 0;
    } catch (e) {
      st.errors++;
      const b = timer.backoff;
      if (b) {
        // 429: Retry-After (default 30 s) plus up to +jitter, never less (all three C1 PollSchedulers).
        if (e instanceof HttpError && e.status === 429) next = (e.retryAfter ?? b.defaultRetryAfterS ?? 30) * 1000 * (1 + (timer.jitterPct ?? 0) * this.rand());
        else { st.failures++; next = this.delay(timer, Math.min(b.capMs ?? 300_000, timer.intervalMs * 2 ** st.failures)); }
      }
    } finally {
      st.running--;
    }
    return next;
  }

  delay(timer, base) {
    const j = timer.jitterPct ?? 0;
    return base * (1 + (j ? (this.rand() * 2 - 1) * j : 0));
  }

  start() {
    const sc = this.screen;
    const runStart = async () => { try { await this.runSteps(sc.onStart ?? [], null, this.abort.signal); } catch { /* first load errors are recorded per request */ } };
    runStart();
    for (const timer of sc.timers ?? []) {
      this.timerState.set(timer.name, { running: 0, runs: 0, overlaps: 0, skippedInflight: 0, skippedHidden: 0, errors: 0, failures: 0 });
      const st = this.timerState.get(timer.name);
      const gate = () => !(this.ctx.hidden && (timer.whenHidden ?? 'run') === 'skip');
      const policy = timer.policy ?? 'fixed-allow-overlap';
      if (policy === 'serial-sleep-then-run' || timer.backoff) {
        // Sleep, then run to completion, then sleep again (iOS Task loops; every "after" scheduler with backoff).
        (async () => {
          let override = null;
          await sleep(timer.firstAfterMs ?? 0, this.abort.signal);
          while (!this.abort.signal.aborted) {
            await sleep(override ?? this.delay(timer, timer.intervalMs), this.abort.signal);
            if (this.abort.signal.aborted) break;
            if (!gate()) { st.skippedHidden++; override = null; continue; }
            if (policy === 'fixed-skip-if-inflight' && st.running) { st.skippedInflight++; continue; }
            override = await this.fire(timer);
          }
        })();
      } else {
        // Fixed-rate timer (Dart Timer.periodic, browser setInterval / TanStack refetchInterval): ticks never wait for
        // the previous run. 'fixed-skip-if-inflight' drops a tick while a run is still in flight (TanStack dedupes a
        // fetch already in flight); 'fixed-allow-overlap' starts another run regardless (Flutter VM Sent Shifts).
        const tick = () => {
          if (this.abort.signal.aborted) return;
          if (!gate()) st.skippedHidden++;
          else if (policy === 'fixed-skip-if-inflight' && st.running) st.skippedInflight++;
          else this.fire(timer);
        };
        const startTicks = () => {
          if (timer.jitterPct) {
            const loop = async () => { while (!this.abort.signal.aborted) { await sleep(this.delay(timer, timer.intervalMs), this.abort.signal); tick(); } };
            loop();
          } else {
            const h = setInterval(tick, timer.intervalMs);
            this.abort.signal.addEventListener('abort', () => clearInterval(h), { once: true });
          }
        };
        if (timer.firstAfterMs) sleep(timer.firstAfterMs, this.abort.signal).then(() => { tick(); startTicks(); });
        else startTicks();
      }
    }
  }

  async setHidden(hidden) {
    const was = this.ctx.hidden;
    this.ctx.hidden = hidden;
    if (was && !hidden && this.screen.onResume?.length) {
      try { await this.runSteps(this.screen.onResume, { name: 'resume', backgroundHeader: false }, this.abort.signal); } catch { /* recorded */ }
    }
  }

  stop() { this.abort.abort(); }

  stats() { return Object.fromEntries([...this.timerState.entries()].map(([k, v]) => [k, { ...v }])); }
}
