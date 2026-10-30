import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { WorkspaceRoutingError } from '../core-modules/tenant/schema-resolver.service';

describe('AllExceptionsFilter', () => {
  function run(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return { status, json };
  }

  it('maps a not-found lookup (an RLS-hidden row looks the same as a missing one) to 404 with a fixed body', () => {
    const { status, json } = run(new EntityNotFoundError('Attendance', { id: 'x' }));
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found.' });
  });

  it('keeps an explicit HttpException status and message unchanged', () => {
    const { status } = run(new NotFoundException('Shift not found.'));
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('converts an unexpected error to a generic 500 that never echoes the error message', () => {
    const { status, json } = run(new Error('relation "core.shift" does not exist'));
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(json.mock.calls)).not.toContain('core.shift');
  });

  it.each(['missing-context', 'registry-missing', 'not-ready', 'name-mismatch', 'unsupported-version'] as const)(
    'maps a WorkspaceRoutingError (%s) to the same 404 an out-of-scope record gets, never a 403 or 500',
    (code) => {
      const { status, json } = run(new WorkspaceRoutingError(code));
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found.' });
    },
  );

  it('maps WorkspaceRoutingError(incompatible-module) to 503 with a fixed body (an availability fault, never 404/403)', () => {
    const { status, json } = run(new WorkspaceRoutingError('incompatible-module'));
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, message: 'Workspace temporarily unavailable.' });
  });
});
