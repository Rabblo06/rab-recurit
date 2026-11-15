import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * XR-09 (Phase X2.5): on SIGTERM/SIGINT the API stops its HTTP listener FIRST, lets the requests already in flight finish,
 * and only then closes the Nest application (every provider's `onModuleDestroy`: the throttler and auth-cache Redis
 * clients, the BullMQ producers, the realtime subscriber), then the database pool.
 *
 * Why not `app.enableShutdownHooks()`: Nest 11 runs `onModuleDestroy` → `beforeApplicationShutdown` → `dispose()` (the
 * HTTP close) → `onApplicationShutdown`, in that order (`@nestjs/core` nest-application-context.js). So the Redis clients
 * quit while the listener still accepted requests, and every credential route answered 503 RATE_LIMIT_UNAVAILABLE from
 * the throttler (`rab-throttler.guard.ts`) for the whole stop window; the HTTP close then waited for open SSE streams.
 *
 * The order now:
 *   1. `server.close()`: no new connection is accepted (a client gets a connection refusal and retries another replica);
 *      Node also closes idle keep-alive sockets at once, and every response still to be sent says `Connection: close`.
 *   2. Wait, at most `drainMs`, until every response still in flight has finished. Server-sent-event streams
 *      (`text/event-stream`, the realtime gateway and the AI stream) never finish on their own and are not waited for.
 *   3. `server.closeAllConnections()`: ends the streams (their clients reconnect elsewhere) and any request still running
 *      at the deadline.
 *   4. `app.close()`: Nest's own hooks, Redis/queue clients included, now that no request can reach them. Its HTTP close
 *      finds the server already closed and resolves at once.
 *   5. The signal is re-raised with no handler installed, exactly as Nest's shutdown hooks do, so the exit status is the
 *      same as before (128 + the signal number; tini is PID 1 in the image).
 *
 * Crewflow-only fix: Twenty's server keeps Nest's default order.
 */

/** How long in-flight requests may take to finish after the listener stops: 15 s of the API's 40 s stop_grace_period. */
export const HTTP_SHUTDOWN_DRAIN_MS = 15_000;

const POLL_MS = 25;
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** The responses an `http.Server` is still writing. Install before the server accepts its first request. */
export interface InFlightResponses {
  pending(): ServerResponse[];
  /** From now on every response that has not sent its headers yet asks the client to close the connection. */
  beginClosing(): void;
}

function askToClose(response: ServerResponse): void {
  if (!response.headersSent) response.setHeader('connection', 'close');
}

/** The `content-type` in a `writeHead` headers argument (an object, a flat `[k, v, k, v]` array or `[[k, v]]`), if any. */
function contentTypeIn(headers: unknown): string | undefined {
  if (Array.isArray(headers)) {
    const pairs: unknown[][] = Array.isArray(headers[0]) ? (headers as unknown[][]) : [];
    if (!pairs.length) for (let i = 0; i + 1 < headers.length; i += 2) pairs.push([headers[i], headers[i + 1]]);
    const found = pairs.find(([name]) => String(name).toLowerCase() === 'content-type');
    return found ? String(found[1]) : undefined;
  }
  if (headers && typeof headers === 'object') {
    const found = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
    return found ? String(found[1]) : undefined;
  }
  return undefined;
}

const startsEventStream = (contentType: unknown): boolean => String(contentType ?? '').toLowerCase().startsWith('text/event-stream');

/**
 * Responses that declared `text/event-stream`. `getHeader()` alone misses a stream whose headers went only through
 * `writeHead(status, headers)` (Nest's SseStream does exactly that): with no earlier `setHeader()` Node writes those
 * headers straight to the socket without storing them. So `writeHead` is observed too.
 */
const eventStreams = new WeakSet<ServerResponse>();

function observeWriteHead(response: ServerResponse): void {
  const writeHead = response.writeHead;
  response.writeHead = function observedWriteHead(this: ServerResponse, ...args: unknown[]) {
    if (startsEventStream(contentTypeIn(typeof args[1] === 'string' ? args[2] : args[1]))) eventStreams.add(this);
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as unknown as ServerResponse['writeHead'];
}

export function trackInFlightResponses(server: Server): InFlightResponses {
  const inFlight = new Set<ServerResponse>();
  let closing = false;
  // prependListener: the application's own request handler (Express, registered when the server was created) must not
  // run first, or a response it answers synchronously would be written before it is tracked and observed.
  server.prependListener('request', (_request: IncomingMessage, response: ServerResponse) => {
    inFlight.add(response);
    observeWriteHead(response);
    response.once('close', () => inFlight.delete(response));
    // A request that still arrives on a kept-alive connection during the drain is served (Redis is still up) and its
    // response closes that connection, so the client's next request opens a new one and meets the closed listener.
    if (closing) askToClose(response);
  });
  return {
    pending: () => [...inFlight],
    beginClosing: () => {
      closing = true;
      inFlight.forEach(askToClose);
    },
  };
}

function isEventStream(response: ServerResponse): boolean {
  return eventStreams.has(response) || startsEventStream(response.getHeader('content-type'));
}

export interface HttpStopResult {
  /** True when every non-stream response finished inside `drainMs`. */
  drained: boolean;
  /** Responses still open when the connections were closed (streams plus any request past the deadline). */
  closedOpen: number;
}

/** Steps 1–3 above. Never throws: a server that is already closed just has nothing left to drain. */
export async function stopHttpListener(server: Server, inFlight: InFlightResponses, drainMs: number): Promise<HttpStopResult> {
  inFlight.beginClosing();
  server.close();
  const deadline = Date.now() + drainMs;
  let drained = inFlight.pending().every(isEventStream);
  while (!drained && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    drained = inFlight.pending().every(isEventStream);
  }
  const closedOpen = inFlight.pending().length;
  server.closeAllConnections();
  return { drained, closedOpen };
}

export interface ShutdownApp {
  getHttpServer(): Server;
  close(): Promise<void>;
}

export interface HttpFirstShutdownOptions {
  drainMs?: number;
  log?: (line: string) => void;
  /** Called with 1 when the shutdown itself fails. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Called after a clean shutdown. Defaults to re-raising the signal with no handler installed (Nest's behaviour). */
  reraise?: (signal: NodeJS.Signals) => void;
  /** False in tests that call `shutdown()` directly instead of sending a signal. */
  listen?: boolean;
}

export interface HttpFirstShutdown {
  shutdown(signal: NodeJS.Signals): Promise<void>;
}

/**
 * Replaces `app.enableShutdownHooks()`. Call it before `app.listen()` (the in-flight tracker must see every request) and
 * before releasing the boot signal guard, so there is no window with neither handler installed.
 */
export function installHttpFirstShutdown(app: ShutdownApp, options: HttpFirstShutdownOptions = {}): HttpFirstShutdown {
  const drainMs = options.drainMs ?? HTTP_SHUTDOWN_DRAIN_MS;
  // eslint-disable-next-line no-console
  const log = options.log ?? ((line: string) => console.log(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const server = app.getHttpServer();
  const inFlight = trackInFlightResponses(server);
  let started: Promise<void> | undefined;

  const onSignal = (signal: NodeJS.Signals): void => void shutdown(signal);
  const removeListeners = (): void => {
    for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, onSignal);
  };
  const reraise =
    options.reraise ??
    ((signal: NodeJS.Signals) => {
      removeListeners();
      process.kill(process.pid, signal);
    });

  function shutdown(signal: NodeJS.Signals): Promise<void> {
    // A second signal while the first shutdown runs is ignored, as Nest's own hooks do.
    started ??= (async () => {
      try {
        log(`rab-server received ${signal}: HTTP listener closed, draining in-flight requests (up to ${drainMs} ms)`);
        const { drained, closedOpen } = await stopHttpListener(server, inFlight, drainMs);
        log(
          drained
            ? `rab-server: in-flight requests finished${closedOpen ? `; closed ${closedOpen} open stream(s)` : ''}; closing Redis, queue and database clients`
            : `rab-server: ${closedOpen} request(s) still open after ${drainMs} ms, closed; closing Redis, queue and database clients`,
        );
        await app.close();
        reraise(signal);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('rab-server shutdown failed:', error instanceof Error ? error.message : 'unknown error');
        exit(1);
      }
    })();
    return started;
  }

  if (options.listen !== false) {
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
  }
  return { shutdown };
}
