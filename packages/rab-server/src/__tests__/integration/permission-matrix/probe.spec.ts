import 'reflect-metadata';
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { cellOf, handlerProbeProblems, probeOf } from './probe';
import { discoverMatrixRoutes } from './route-discovery';

/**
 * The permission matrix's probe rules, without a database: a route the probe cannot stop before its handler must be
 * classified, and a side-effect-free probe that gets past the guards must get exactly its boundary answer.
 */
class NameDto {
  @IsString() name!: string;
}

@Controller('rest/v1/matrix-probe-fake')
@UseGuards(JwtAuthGuard)
class MatrixProbeFakeController {
  /** Unvalidated body: the ValidationPipe skips a plain object type, so a probe would run this handler. */
  @Post('unvalidated')
  unvalidated(@Body() body: Record<string, unknown>) {
    return body;
  }

  @Post('validated')
  validated(@Body() dto: NameDto) {
    return dto;
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { id, body };
  }

  @Get('list')
  list(@Query() query: NameDto) {
    return query;
  }
}

describe('permission matrix probe rules', () => {
  const routes = discoverMatrixRoutes([MatrixProbeFakeController]);
  const route = (key: string) => routes.find((r) => r.key === key)!;

  it('classifies each fake route by what stops it before the handler', () => {
    expect(Object.fromEntries(routes.map((r) => [r.key, probeOf(r)]))).toEqual({
      'GET /rest/v1/matrix-probe-fake/list': 'read',
      'PATCH /rest/v1/matrix-probe-fake/:id': 'record',
      'POST /rest/v1/matrix-probe-fake/unvalidated': 'handler',
      'POST /rest/v1/matrix-probe-fake/validated': 'body',
    });
  });

  it('a new route with an unvalidated @Body() fails the suite until it is listed with a decision', () => {
    expect(handlerProbeProblems(routes).unlisted).toEqual(['POST /rest/v1/matrix-probe-fake/unvalidated']);
  });

  it('past the guards, a body or query probe is ok only on the ValidationPipe 400 (a handler that ran is a failure)', () => {
    const body = probeOf(route('POST /rest/v1/matrix-probe-fake/validated'));
    expect(cellOf(body, { status: 400, guardsPassed: true })).toBe('ok');
    for (const status of [200, 201, 204, 404, 409]) expect([status, cellOf(body, { status, guardsPassed: true })]).toEqual([status, null]);
    expect(cellOf('query', { status: 200, guardsPassed: true })).toBeNull();
  });

  it("past the guards, a record probe is ok only on the interceptor's plain 404", () => {
    const record = probeOf(route('PATCH /rest/v1/matrix-probe-fake/:id'));
    expect(cellOf(record, { status: 404, guardsPassed: true })).toBe('ok');
    expect(cellOf(record, { status: 404, code: 'SOMETHING', guardsPassed: true })).toBeNull();
    for (const status of [200, 400, 403]) expect([status, cellOf(record, { status, guardsPassed: true })]).toEqual([status, null]);
  });

  it('a guard refusal is 403 / 404 by status, whatever the probe; 401, 429 and 5xx never pass', () => {
    for (const probe of ['record', 'body', 'query', 'read', 'handler'] as const) {
      expect(cellOf(probe, { status: 403, guardsPassed: false })).toBe('403');
      expect(cellOf(probe, { status: 404, guardsPassed: false })).toBe('404');
      for (const status of [200, 400, 401, 429, 500, 503]) expect([probe, status, cellOf(probe, { status, guardsPassed: false })]).toEqual([probe, status, null]);
      for (const status of [401, 429, 500]) expect([probe, status, cellOf(probe, { status, guardsPassed: true })]).toEqual([probe, status, null]);
    }
  });

  it('a read or handler that ran answers for itself', () => {
    expect(cellOf('read', { status: 200, guardsPassed: true })).toBe('ok');
    expect(cellOf('read', { status: 403, guardsPassed: true })).toBe('403');
    expect(cellOf('read', { status: 404, guardsPassed: true })).toBe('404');
    expect(cellOf('handler', { status: 404, guardsPassed: true })).toBe('ok');
    expect(cellOf('handler', { status: 403, guardsPassed: true })).toBe('403');
  });
});
