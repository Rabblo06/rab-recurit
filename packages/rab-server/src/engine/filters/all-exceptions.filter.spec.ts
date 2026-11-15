import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { EntityNotFoundError } from 'typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { ExceptionHandlerService } from '../core-modules/exception-handler/exception-handler.service';
import { WorkspaceRoutingError } from '../core-modules/tenant/schema-resolver.service';

describe('AllExceptionsFilter', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  function run(
    exception: unknown,
    handler: Pick<ExceptionHandlerService, 'captureExceptions'> = { captureExceptions: jest.fn(() => []) },
    request: unknown = { method: 'GET', url: '/rest/v1/shifts/0b6c?token=abc', route: { path: '/rest/v1/shifts/:id' } },
  ) {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => request }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter(handler as ExceptionHandlerService).catch(exception, host);
    return { status, json, handler };
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

  it('Part D (owner D2/D3): WorkspaceRoutingError(upgrading) is 503 "Workspace is being upgraded." (fixed body, no detail)', () => {
    const { status, json } = run(new WorkspaceRoutingError('upgrading'));
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, message: 'Workspace is being upgraded.' });
  });

  describe('Phase X3.2: the 500 branch reports to the exception handler (Sentry)', () => {
    it('a 500 calls the handler once with the exception and the route PATTERN (never the path or query string)', () => {
      const error = new Error('relation "core.shift" does not exist');
      const captureExceptions = jest.fn<string[], [ReadonlyArray<unknown>, unknown?]>(() => ['event-1']);
      const { status } = run(error, { captureExceptions });
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captureExceptions).toHaveBeenCalledTimes(1);
      expect(captureExceptions).toHaveBeenCalledWith([error], { operation: { type: 'http', name: 'GET /rest/v1/shifts/:id' } });
      expect(JSON.stringify(captureExceptions.mock.calls[0]![1])).not.toMatch(/0b6c|token|abc/);
    });

    it('an unmatched route reports `unmatched`, never the request URL', () => {
      const captureExceptions = jest.fn(() => []);
      run(new Error('boom'), { captureExceptions }, { method: 'POST', url: '/x/bob@example.com' });
      expect(captureExceptions).toHaveBeenCalledWith([expect.any(Error)], { operation: { type: 'http', name: 'POST unmatched' } });
    });

    it.each<[string, unknown]>([
      ['400 BadRequestException', new BadRequestException('bad')],
      ['401 UnauthorizedException', new UnauthorizedException()],
      ['403 ForbiddenException', new ForbiddenException()],
      ['404 NotFoundException', new NotFoundException('Shift not found.')],
      ['409 ConflictException', new ConflictException()],
      ['400 MulterError', new MulterError('LIMIT_FILE_SIZE')],
      ['404 EntityNotFoundError', new EntityNotFoundError('Attendance', { id: 'x' })],
      ['404 WorkspaceRoutingError', new WorkspaceRoutingError('not-ready')],
      ['503 WorkspaceRoutingError(incompatible-module)', new WorkspaceRoutingError('incompatible-module')],
    ])('%s does not call the handler', (_label, exception) => {
      const captureExceptions = jest.fn(() => []);
      run(exception, { captureExceptions });
      expect(captureExceptions).not.toHaveBeenCalled();
    });

    it.each<[number, string, unknown]>([
      [413, 'Payload too large.', Object.assign(new Error('request entity too large'), { expose: true, status: 413, statusCode: 413, type: 'entity.too.large' })],
      [415, 'Unsupported media type.', Object.assign(new Error('unsupported charset "EVIL-x32"'), { expose: true, status: 415, statusCode: 415, type: 'charset.unsupported' })],
      [400, 'Bad request.', Object.assign(new SyntaxError('Unexpected end of JSON input'), { expose: true, status: 400, statusCode: 400, type: 'entity.parse.failed' })],
      [429, 'Request rejected.', Object.assign(new Error('x'), { expose: true, statusCode: 429 })],
    ])('an http-errors client error (%i) keeps its status with a fixed body and is not reported (F2)', (code, message, exception) => {
      const captureExceptions = jest.fn(() => []);
      const { status, json } = run(exception, { captureExceptions });
      expect(status).toHaveBeenCalledWith(code);
      expect(json).toHaveBeenCalledWith({ statusCode: code, message });
      expect(JSON.stringify(json.mock.calls)).not.toContain('EVIL-x32');
      expect(captureExceptions).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ['no expose flag (an upstream SDK error carrying a status)', Object.assign(new Error('upstream 403'), { status: 403 })],
      ['expose but a 5xx status', Object.assign(new Error('x'), { expose: true, status: 502 })],
      ['expose with a non-integer status', Object.assign(new Error('x'), { expose: true, status: '413' })],
    ])('%s stays a reported generic 500', (_label, exception) => {
      const captureExceptions = jest.fn(() => []);
      const { status } = run(exception, { captureExceptions });
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captureExceptions).toHaveBeenCalledTimes(1);
    });

    it('a throwing handler never changes the response: still the same generic 500 body', () => {
      const throwing = { captureExceptions: jest.fn(() => { throw new Error('sentry down'); }) };
      const { status, json } = run(new Error('boom'), throwing);
      expect(throwing.captureExceptions).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
    });

    it('a request object that throws on access never changes the response', () => {
      const hostileRequest = new Proxy({}, { get: () => { throw new Error('getter'); } });
      const captureExceptions = jest.fn(() => []);
      const { status, json } = run(new Error('boom'), { captureExceptions }, hostileRequest);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
    });
  });
});
