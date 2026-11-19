import type { NextFunction, Request, Response } from 'express';

import { EnvironmentService } from '../environment/environment.service';
import { FirstPeerLogMiddleware, isLoopbackPeer, suggestedTrustedProxyCidr } from './first-peer-log.middleware';

/** A request carrying every header a proxy or an attacker could set, plus a path, query and body, all marked. */
function request(remoteAddress: string | undefined): Request {
  return {
    socket: { remoteAddress },
    headers: {
      'x-forwarded-for': '203.0.113.250, 198.51.100.250',
      'cf-connecting-ip': '203.0.113.251',
      'x-real-ip': '203.0.113.252',
      host: 'header-host.example',
      authorization: 'Bearer SECRET-TOKEN-MARK',
      cookie: 'session=SECRET-COOKIE-MARK',
    },
    method: 'POST',
    url: '/rest/v1/secret-path-mark?q=query-mark',
    originalUrl: '/rest/v1/secret-path-mark?q=query-mark',
    path: '/rest/v1/secret-path-mark',
    body: { password: 'BODY-MARK' },
    ip: '203.0.113.253',
  } as unknown as Request;
}

function middleware(flag: boolean | undefined) {
  const lines: string[] = [];
  const environment = { get: jest.fn((key: string) => (key === 'CREWFLOW_LOG_FIRST_PEER' ? flag : undefined)) };
  const mw = new FirstPeerLogMiddleware(environment as unknown as EnvironmentService, (line) => lines.push(line));
  const next = jest.fn() as unknown as NextFunction;
  const run = (remoteAddress: string | undefined) => mw.use(request(remoteAddress), {} as Response, next);
  return { lines, run, next, environment };
}

/** Every marked value from request(): none may ever appear in a logged line. */
const MARKS = ['203.0.113.25', '198.51.100.250', 'header-host', 'SECRET', 'secret-path-mark', 'query-mark', 'BODY-MARK', 'POST', 'Bearer', 'session='];

describe('FirstPeerLogMiddleware (CREWFLOW_LOG_FIRST_PEER, TRUSTED_PROXY_CIDRS discovery)', () => {
  it('logs only the socket peer address (and the /32 built from it), never a header, path, query, body or method', () => {
    const { lines, run, next } = middleware(true);
    run('10.42.7.9');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'CREWFLOW_LOG_FIRST_PEER: first request peer address (req.socket.remoteAddress) = 10.42.7.9; as TRUSTED_PROXY_CIDRS: 10.42.7.9/32. Logged once. Remove CREWFLOW_LOG_FIRST_PEER after setting TRUSTED_PROXY_CIDRS.',
    );
    for (const mark of MARKS) expect(lines[0]).not.toContain(mark);
    // The only address-shaped value in the line is the peer itself.
    expect(lines[0].match(/\d+\.\d+\.\d+\.\d+/g)).toEqual(['10.42.7.9', '10.42.7.9']);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('logs once per process: later requests, from the same or another peer, log nothing', () => {
    const { lines, run, next } = middleware(true);
    run('10.42.7.9');
    run('10.42.7.9');
    run('172.18.0.5');
    run('2001:db8::7');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('= 10.42.7.9;');
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('skips the container-local health check (loopback) and logs the first outside peer', () => {
    const { lines, run } = middleware(true);
    run('127.0.0.1');
    run('::1');
    run('::ffff:127.0.0.1');
    expect(lines).toEqual([]);
    run('::ffff:10.0.3.4');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('= ::ffff:10.0.3.4; as TRUSTED_PROXY_CIDRS: 10.0.3.4/32.');
  });

  it('an IPv6 peer is suggested as a /128', () => {
    const { lines, run } = middleware(true);
    run('2001:db8::7');
    expect(lines[0]).toContain('= 2001:db8::7; as TRUSTED_PROXY_CIDRS: 2001:db8:0:0:0:0:0:7/128.');
  });

  it('a request without a socket address is not counted (the next one is logged)', () => {
    const { lines, run } = middleware(true);
    run(undefined);
    run('');
    expect(lines).toEqual([]);
    run('10.1.2.3');
    expect(lines).toHaveLength(1);
  });

  it('a value that does not look like an address is never echoed, and still counts as the one line', () => {
    const { lines, run } = middleware(true);
    run('not-an-address <script>');
    run('10.1.2.3');
    expect(lines).toEqual(['CREWFLOW_LOG_FIRST_PEER: the first request peer address could not be read (not shown). Logged once.']);
  });

  it.each([false, undefined])('off (%s, the default): nothing is logged, every request passes through', (flag) => {
    const { lines, run, next } = middleware(flag);
    run('10.42.7.9');
    run('2001:db8::7');
    expect(lines).toEqual([]);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('helpers: loopback detection and the suggested CIDR', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isLoopbackPeer('garbage')).toBe(false);
    expect(suggestedTrustedProxyCidr('::ffff:192.0.2.1')).toBe('192.0.2.1/32');
    expect(suggestedTrustedProxyCidr('garbage')).toBeNull();
  });
});
