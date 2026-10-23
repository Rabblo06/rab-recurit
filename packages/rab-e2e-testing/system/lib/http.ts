import { request as httpRequest } from 'node:http';

import { API_HOST, API_PORT, DEFAULT_HOST, DEFAULT_ORIGIN } from './env';

export interface HttpResponse<T = any> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  text: string;
  ms: number;
}

export interface ClientOptions {
  /** The Host the API sees (the browser's host through the same-origin proxy). Default: the default console host. */
  host?: string;
  /** Origin sent on every request (CSRF/provenance checks). `null` sends none. */
  origin?: string | null;
  /** Mobile transport: `X-Client-Platform: mobile` + Bearer access token (no cookies). */
  mobile?: boolean;
  label?: string;
  /** Wait out a 429 (Retry-After) on /auth/* routes and retry, like a real client. Default true; the limiter test turns it off. */
  honour429?: boolean;
}

/**
 * Minimal real-HTTP client for the disposable API (node:http, so the Host header is fully controllable — the API derives
 * the workspace host from it exactly as it does behind the Vite proxy). Web clients keep a cookie jar; mobile clients use
 * Bearer tokens. Nothing is mocked.
 */
export class ApiClient {
  readonly cookies = new Map<string, string>();
  bearer?: string;
  refreshToken?: string;
  host: string;
  origin: string | null;
  readonly mobile: boolean;
  readonly label: string;
  readonly honour429: boolean;

  constructor(opts: ClientOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.origin = opts.origin === undefined ? DEFAULT_ORIGIN : opts.origin;
    this.mobile = opts.mobile ?? false;
    this.label = opts.label ?? 'client';
    this.honour429 = opts.honour429 ?? true;
  }

  clone(opts: ClientOptions = {}): ApiClient {
    const c = new ApiClient({ host: opts.host ?? this.host, origin: opts.origin === undefined ? this.origin : opts.origin, mobile: opts.mobile ?? this.mobile, label: opts.label ?? this.label, honour429: opts.honour429 ?? this.honour429 });
    for (const [k, v] of this.cookies) c.cookies.set(k, v);
    c.bearer = this.bearer;
    c.refreshToken = this.refreshToken;
    return c;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorbCookies(setCookie: string[] | string | undefined): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async req<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<HttpResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.once<T>(method, path, body, extra);
      if (res.status !== 429 || !this.honour429 || !path.startsWith('/rest/v1/auth/') || attempt >= 4) return res;
      const wait = Number(res.headers['retry-after'] ?? 30);
      throttleWaits.push({ label: `${this.label} ${path}`, seconds: wait });
      await new Promise((r) => setTimeout(r, (Number.isFinite(wait) ? wait : 30) * 1000 + 500));
    }
  }

  private async once<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<HttpResponse<T>> {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const headers: Record<string, string> = { Host: this.host, Accept: 'application/json' };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (this.origin) headers.Origin = this.origin;
    if (this.mobile) headers['X-Client-Platform'] = 'mobile';
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    const cookie = this.cookieHeader();
    if (cookie && !this.mobile) headers.Cookie = cookie;
    Object.assign(headers, extra);
    for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const r = httpRequest({ host: API_HOST, port: API_PORT, method, path, headers, timeout: 60_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          this.absorbCookies(res.headers['set-cookie']);
          let parsed: any = text;
          if ((res.headers['content-type'] ?? '').includes('json') && text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text, ms: performance.now() - started });
        });
      });
      r.on('timeout', () => r.destroy(new Error(`timeout ${method} ${path}`)));
      r.on('error', reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  }

  get<T = any>(path: string, extra?: Record<string, string>) {
    return this.req<T>('GET', path, undefined, extra);
  }
  post<T = any>(path: string, body: unknown = {}, extra?: Record<string, string>) {
    return this.req<T>('POST', path, body, extra);
  }
  patch<T = any>(path: string, body: unknown = {}, extra?: Record<string, string>) {
    return this.req<T>('PATCH', path, body, extra);
  }
  put<T = any>(path: string, body: unknown = {}, extra?: Record<string, string>) {
    return this.req<T>('PUT', path, body, extra);
  }
  del<T = any>(path: string, extra?: Record<string, string>) {
    return this.req<T>('DELETE', path, undefined, extra);
  }

  /**
   * Password sign-in. Web: cookie session; mobile: keeps the Bearer + refresh token from the body.
   * Every client of this suite shares ONE source IP (the Docker port-forward), so the real per-IP login throttle
   * (5/min) applies to the whole suite; like a real client, a 429 is honoured (Retry-After) and retried.
   */
  async login(email: string, password: string, extraBody: Record<string, unknown> = {}): Promise<HttpResponse> {
    const res = await this.post('/rest/v1/auth/login', { email, password, ...extraBody });
    if (res.status === 200) this.absorbTokens(res.body);
    return res;
  }

  absorbTokens(body: any): void {
    if (this.mobile && body?.accessToken) {
      this.bearer = body.accessToken;
      if (body.refreshToken) this.refreshToken = body.refreshToken;
    }
  }
}

/** Every 429 the suite had to wait out (reported, so throttle time is never mistaken for latency). */
export const throttleWaits: { label: string; seconds: number }[] = [];

/** Throws with the response body when the status is not one of `ok`. */
export function expectStatus<T>(res: HttpResponse<T>, ok: number | number[], what: string): HttpResponse<T> {
  const list = Array.isArray(ok) ? ok : [ok];
  if (!list.includes(res.status)) {
    throw new Error(`${what}: expected ${list.join('/')} got ${res.status} ${res.text.slice(0, 600)}`);
  }
  return res;
}

/** Lists come back either as an array or as `{ data, ... }` / `{ items, ... }` pages. */
export function rows(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.results)) return body.results;
  return [];
}
