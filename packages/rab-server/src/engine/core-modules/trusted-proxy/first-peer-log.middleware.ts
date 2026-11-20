import { Inject, Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';

import { EnvironmentService } from '../environment/environment.service';

/** Where the line goes: one string, nothing else. Unset = the Nest logger ("TrustedProxy"); tests inject a recorder. */
export type FirstPeerLogSink = (line: string) => void;
export const FIRST_PEER_LOG_SINK = Symbol('FIRST_PEER_LOG_SINK');

/** Characters a socket address can contain (IPv4, IPv6, an IPv6 zone id). Anything else is never echoed. */
const ADDRESS_SHAPE = /^[0-9A-Fa-f:.%]{2,64}$/;

/**
 * The address as it should appear in TRUSTED_PROXY_CIDRS: IPv4 (also an IPv4-mapped IPv6 peer such as ::ffff:10.0.0.5,
 * which Node reports on a dual-stack socket) as a /32, IPv6 as a /128. null for anything unparseable.
 */
export function suggestedTrustedProxyCidr(remoteAddress: string): string | null {
  try {
    const peer = ipaddr.process(remoteAddress);
    return peer.kind() === 'ipv4' ? `${peer.toString()}/32` : `${peer.toNormalizedString()}/128`;
  } catch {
    return null;
  }
}

/** The container's own loopback (the compose health check, `wget http://localhost:3000/healthz`), never the edge proxy. */
export function isLoopbackPeer(remoteAddress: string): boolean {
  try {
    return ipaddr.process(remoteAddress).range() === 'loopback';
  } catch {
    return false;
  }
}

/**
 * TRUSTED_PROXY_CIDRS discovery on a host without a shell (hosted OpenShip). Production refuses to boot without
 * TRUSTED_PROXY_CIDRS, and the right value is the address of whatever connects to this container: the platform's edge
 * proxy. With CREWFLOW_LOG_FIRST_PEER=true this middleware logs that address ONCE per process: the socket peer
 * (`req.socket.remoteAddress`) of the first request whose peer is not the container's own loopback (the health check runs
 * inside the container every 10 s and would otherwise always be "first").
 *
 * What is logged: the peer address and the /32 (/128) built from it. Nothing else: no header (X-Forwarded-For,
 * CF-Connecting-IP, Host, cookies, Authorization), no method, path, query or body, no user or session, no configuration
 * value. The socket address is the TCP peer, which the client cannot choose (unlike every forwarding header). A value that
 * does not look like an address is not echoed. Off (the default): one boolean check per request, nothing logged.
 * The operator steps are in packages/rab-docker/docs/release/ENV-REFERENCE.md ("Finding TRUSTED_PROXY_CIDRS").
 */
@Injectable()
export class FirstPeerLogMiddleware implements NestMiddleware {
  private readonly enabled: boolean;
  private readonly sink: FirstPeerLogSink;
  private logged = false;

  constructor(environment: EnvironmentService, @Optional() @Inject(FIRST_PEER_LOG_SINK) sink?: FirstPeerLogSink) {
    this.enabled = environment.get('CREWFLOW_LOG_FIRST_PEER') === true;
    const logger = new Logger('TrustedProxy');
    this.sink = sink ?? ((line) => logger.log(line));
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    if (this.enabled && !this.logged) this.observe(req.socket?.remoteAddress);
    next();
  }

  private observe(remoteAddress: string | undefined): void {
    if (typeof remoteAddress !== 'string' || remoteAddress === '') return; // a closed socket: wait for the next request
    if (isLoopbackPeer(remoteAddress)) return; // the container's own health check, never the proxy
    this.logged = true;
    if (!ADDRESS_SHAPE.test(remoteAddress)) {
      this.sink('CREWFLOW_LOG_FIRST_PEER: the first request peer address could not be read (not shown). Logged once.');
      return;
    }
    const cidr = suggestedTrustedProxyCidr(remoteAddress);
    this.sink(
      `CREWFLOW_LOG_FIRST_PEER: first request peer address (req.socket.remoteAddress) = ${remoteAddress}` +
        (cidr ? `; as TRUSTED_PROXY_CIDRS: ${cidr}` : '') +
        '. Logged once. Remove CREWFLOW_LOG_FIRST_PEER after setting TRUSTED_PROXY_CIDRS.',
    );
  }
}
