import { createHash, generateKeyPairSync, KeyObject, randomBytes, sign as cryptoSign } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A deterministic, local OpenID Connect provider for tests (TEST CODE ONLY — never imported by the server).
 *
 * It implements just enough of the authorization-code + PKCE flow for `openid-client` to exercise its REAL
 * validation path end to end: discovery, JWKS, `/token` (client_secret_basic or _post, PKCE S256 check, single-use
 * codes) and RS256-signed ID tokens. Tests decide the identity and may deliberately corrupt the response (wrong
 * issuer/audience/nonce, bad signature, expired token) to prove the server rejects it.
 *
 * `/authorize` renders a tiny account chooser (for browser tests) listing the configured accounts; selecting one
 * redirects back with `code` + `state`. Integration tests skip the page and call `issueCode()` directly with the
 * parameters the server put in its redirect URL.
 */

export interface MockAccount {
  sub: string;
  email: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  /** Extra ID-token claims (e.g. Microsoft `tid`, `oid`, `xms_edov`). */
  extra?: Record<string, unknown>;
}

export interface Tamper {
  issuer?: string;
  audience?: string;
  nonce?: string;
  expiresInSeconds?: number;
  /** Sign with a key that is NOT published in the JWKS. */
  foreignKey?: boolean;
  /** Return a token endpoint error instead of tokens. */
  tokenError?: boolean;
}

interface PendingCode {
  account: MockAccount;
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  tamper: Tamper;
  used: boolean;
}

export class MockOidcProvider {
  private server!: Server;
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = randomBytes(8).toString('hex');
  private readonly codes = new Map<string, PendingCode>();
  issuer = '';
  /** Accounts offered by the browser account chooser. */
  accounts: MockAccount[] = [];
  /** Applied to the next code issued through the browser chooser. */
  nextTamper: Tamper = {};
  tokenRequests = 0;

  constructor(private readonly clientId: string, private readonly clientSecret: string) {}

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Simulates the user picking `account` on the provider for the server's own authorization URL. */
  issueCode(authorizationUrl: string, account: MockAccount, tamper: Tamper = {}): { code: string; state: string; redirectUri: string } {
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    if (params.get('code_challenge_method') !== 'S256') throw new Error('mock IdP: PKCE S256 required');
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      account,
      clientId: params.get('client_id') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      nonce: params.get('nonce') ?? '',
      codeChallenge: params.get('code_challenge') ?? '',
      tamper,
      used: false,
    });
    return { code, state: params.get('state') ?? '', redirectUri: params.get('redirect_uri') ?? '' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }
    if (url.pathname === '/jwks') {
      return this.json(res, 200, { keys: [{ ...this.key.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }] });
    }
    if (url.pathname === '/authorize') return this.chooser(url, res);
    if (url.pathname === '/token' && req.method === 'POST') return this.token(req, res);
    res.statusCode = 404;
    res.end('not found');
  }

  /** Browser account chooser: lists accounts; `?pick=<index>` completes the selection. */
  private chooser(url: URL, res: ServerResponse): void {
    const pick = url.searchParams.get('pick');
    if (pick !== null) {
      const account = this.accounts[Number(pick)];
      if (!account) {
        res.statusCode = 400;
        res.end('unknown account');
        return;
      }
      const issued = this.issueCode(url.toString(), account, this.nextTamper);
      this.nextTamper = {};
      res.statusCode = 302;
      res.setHeader('Location', `${issued.redirectUri}?code=${encodeURIComponent(issued.code)}&state=${encodeURIComponent(issued.state)}`);
      res.end();
      return;
    }
    const base = new URL(url.toString());
    const items = this.accounts
      .map((account, index) => {
        base.searchParams.set('pick', String(index));
        return `<li><a data-email="${account.email}" href="${base.pathname}${base.search}">${account.given_name ?? ''} ${account.family_name ?? ''} &lt;${account.email}&gt;</a></li>`;
      })
      .join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Choose an account</title><h1>Choose an account</h1><p>Mock identity provider (tests)</p><ul>${items}</ul>`);
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.tokenRequests += 1;
    const body = new URLSearchParams(await readBody(req));
    let clientId = body.get('client_id');
    let clientSecret = body.get('client_secret');
    const basic = req.headers.authorization;
    if (basic?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
      clientId = decodeURIComponent(id ?? '');
      clientSecret = decodeURIComponent(secret ?? '');
    }
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) return this.json(res, 401, { error: 'invalid_client' });
    const pending = this.codes.get(body.get('code') ?? '');
    if (!pending || pending.used) return this.json(res, 400, { error: 'invalid_grant' });
    pending.used = true;
    if (pending.tamper.tokenError) return this.json(res, 400, { error: 'invalid_grant' });
    if (body.get('redirect_uri') !== pending.redirectUri) return this.json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
    const verifier = body.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge) {
      return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
    }
    const now = Math.floor(Date.now() / 1000);
    const { account, tamper } = pending;
    const claims = {
      iss: tamper.issuer ?? this.issuer,
      aud: tamper.audience ?? pending.clientId,
      sub: account.sub,
      email: account.email,
      email_verified: account.email_verified ?? true,
      given_name: account.given_name,
      family_name: account.family_name,
      nonce: tamper.nonce ?? pending.nonce,
      iat: now,
      exp: now + (tamper.expiresInSeconds ?? 300),
      ...account.extra,
    };
    const idToken = signJwt(claims, tamper.foreignKey ? this.foreign.privateKey : this.key.privateKey, this.kid);
    return this.json(res, 200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }
}

function signJwt(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
