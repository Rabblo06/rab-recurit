import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';

import {
  installStepUpRetry,
  registerStepUpHandler,
} from '../../../shared/lib/step-up-retry';

/**
 * Proves the contract `mfaApi.ts` relies on: a request carrying `_stepUpRetried: true` gets a 403 STEP_UP_REQUIRED back
 * as an error (so the Security dialog can show its own "confirm it's you" state), and the global prompt is NOT opened;
 * a plain request still opens it. Uses the real interceptor from `shared/lib/step-up-retry.ts`.
 */
function instanceAnswering403() {
  const instance = axios.create({
    adapter: async (config: InternalAxiosRequestConfig) => {
      const response = {
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config,
        data: { code: 'STEP_UP_REQUIRED', mfa: false },
      };
      throw new AxiosError(
        'Forbidden',
        'ERR_BAD_REQUEST',
        config,
        null,
        response,
      );
    },
  });
  installStepUpRetry(instance);
  return instance;
}

it('a request marked as handling its own proof is not intercepted', async () => {
  const handler = jest.fn().mockResolvedValue(false);
  const unregister = registerStepUpHandler(handler);
  const instance = instanceAnswering403();
  await expect(
    instance.post('/auth/mfa/enrolment', {}, {
      _stepUpRetried: true,
    } as unknown as AxiosRequestConfig),
  ).rejects.toMatchObject({ response: { status: 403 } });
  expect(handler).not.toHaveBeenCalled();
  await expect(instance.post('/auth/mfa/enrolment', {})).rejects.toMatchObject({
    response: { status: 403 },
  });
  expect(handler).toHaveBeenCalledTimes(1);
  unregister();
});
