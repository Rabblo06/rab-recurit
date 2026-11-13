/**
 * Phase X3.2 review F2: client errors thrown by Express's body parser (before any guard or throttler) keep their 4xx
 * status with a fixed body and are never reported to Sentry. Real HTTP through a Nest app built the way main.ts builds
 * it (Nest's default JSON / urlencoded body parser, AllExceptionsFilter as the APP_FILTER). Before X3.2 the 413 and both
 * 415 cases returned the generic 500; malformed JSON was already a 400 (Nest maps it to a BadRequestException).
 */
import { Body, Controller, HttpStatus, INestApplication, Logger, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ExceptionHandlerService } from '../core-modules/exception-handler/exception-handler.service';
import { applyGlobalValidationPipe } from '../utils/global-validation-pipe';
import { AllExceptionsFilter } from './all-exceptions.filter';

@Controller('probe')
class ProbeController {
  @Post()
  echo(@Body() body: unknown): { ok: true; keys: number } {
    return { ok: true, keys: body && typeof body === 'object' ? Object.keys(body).length : 0 };
  }

  @Post('boom')
  boom(): never {
    throw new Error('unexpected server fault');
  }
}

const ATTACKER_CHARSET = 'x32-attacker-charset-marker';

describe('AllExceptionsFilter over real HTTP: body-parser client errors (X3.2 F2)', () => {
  let app: INestApplication;
  const captureExceptions = jest.fn((_exceptions: ReadonlyArray<unknown>, _options?: unknown) => [] as string[]);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: ExceptionHandlerService, useValue: { captureExceptions } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication({ logger: false }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => captureExceptions.mockClear());

  it('an oversized body (200 KB > the 100 KB default) → 413 with a fixed body, not reported', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ filler: 'a'.repeat(200 * 1024) }));
    expect(res.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(res.body).toEqual({ statusCode: 413, message: 'Payload too large.' });
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('an attacker-chosen charset → 415 with a fixed body that never echoes it, not reported', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .set('content-type', `application/json; charset=${ATTACKER_CHARSET}`)
      .send('{"a":1}');
    expect(res.status).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(res.body).toEqual({ statusCode: 415, message: 'Unsupported media type.' });
    expect(res.text).not.toContain(ATTACKER_CHARSET);
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('an unsupported content-encoding → 415 with a fixed body, not reported', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .set('content-type', 'application/json')
      .set('content-encoding', 'evil-enc')
      .send('{"a":1}');
    expect(res.status).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(res.body).toEqual({ statusCode: 415, message: 'Unsupported media type.' });
    expect(res.text).not.toContain('evil-enc');
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('malformed JSON → 400, not reported (Nest already maps the parse failure to a BadRequestException; unchanged)', async () => {
    const res = await request(app.getHttpServer()).post('/probe').set('content-type', 'application/json').send('{"a":');
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('control: a valid body still reaches the handler, and a real server fault is still a reported 500', async () => {
    const ok = await request(app.getHttpServer()).post('/probe').send({ a: 1 });
    expect(ok.status).toBe(HttpStatus.CREATED);
    expect(captureExceptions).not.toHaveBeenCalled();
    const boom = await request(app.getHttpServer()).post('/probe/boom').send({});
    expect(boom.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(boom.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(captureExceptions).toHaveBeenCalledTimes(1);
    expect(captureExceptions.mock.calls[0]![1]).toEqual({ operation: { type: 'http', name: 'POST /probe/boom' } });
  });
});
