/**
 * What a caller may attach to an exception report. Deliberately narrower than Twenty's options (which also carry the
 * user, the workspace, a GraphQL document and free-form `additionalData`): Crewflow attaches only a fixed operation kind
 * and a data-free name (an HTTP route PATTERN such as `GET /rest/v1/shifts/:id`, or a Worker loop name), so nothing
 * typed by a user, no identifier and no request content can enter an event through this door. `instrument.ts`'s
 * `beforeSend` scrubs every event on its way out regardless.
 */
export interface ExceptionHandlerOptions {
  operation?: {
    type: 'http' | 'worker-cycle';
    name: string;
  };
}

/** One driver per process: Sentry when it is on, otherwise the no-op driver. Returns the ids of the events it sent. */
export interface ExceptionHandlerDriverInterface {
  captureExceptions(exceptions: ReadonlyArray<unknown>, options?: ExceptionHandlerOptions): string[];
}
