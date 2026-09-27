import { TokenCryptoService } from './token-crypto.service';
import { hashPassword, verifyPassword } from './gateway-auth.service';
import { buildUpstreamHeaders } from './gateway-proxy';

describe('TokenCryptoService', () => {
  beforeAll(() => {
    process.env.GATEWAY_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  it('round-trips a token', () => {
    const svc = new TokenCryptoService();
    const token = 'sk-ant-oat01-example-token-value';
    expect(svc.decrypt(svc.encrypt(token))).toBe(token);
  });

  it('produces distinct ciphertexts per call', () => {
    const svc = new TokenCryptoService();
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('rejects tampered ciphertext', () => {
    const svc = new TokenCryptoService();
    const payload = svc.encrypt('secret');
    const parts = payload.split('$');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => svc.decrypt(parts.join('$'))).toThrow();
  });

  it('rejects unknown formats', () => {
    const svc = new TokenCryptoService();
    expect(() => svc.decrypt('v2$a$b$c')).toThrow('Unrecognized');
  });
});

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('hunter2secret');
    expect(verifyPassword('hunter2secret', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('hunter2secret');
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('rejects malformed stored hashes', () => {
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('buildUpstreamHeaders', () => {
  const token = 'sk-ant-oat01-test';

  it('replaces client auth with the account token', () => {
    const out = buildUpstreamHeaders(
      { authorization: 'Bearer fkgw_clientkey', 'x-api-key': 'fkgw_clientkey' },
      token,
    );
    expect(out['authorization']).toBe(`Bearer ${token}`);
    expect(out['x-api-key']).toBeUndefined();
  });

  it('strips hop-by-hop headers and host', () => {
    const out = buildUpstreamHeaders(
      {
        host: 'gateway.example.com',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'proxy-authorization': 'x',
        'content-type': 'application/json',
      },
      token,
    );
    expect(out['host']).toBeUndefined();
    expect(out['connection']).toBeUndefined();
    expect(out['transfer-encoding']).toBeUndefined();
    expect(out['proxy-authorization']).toBeUndefined();
    expect(out['content-type']).toBe('application/json');
  });

  it('forwards anthropic headers verbatim and ensures the oauth beta', () => {
    const out = buildUpstreamHeaders(
      {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'context-1m-2025-08-07,prompt-caching-2024-07-31',
      },
      token,
    );
    expect(out['anthropic-version']).toBe('2023-06-01');
    expect(out['anthropic-beta']).toBe(
      'context-1m-2025-08-07,prompt-caching-2024-07-31,oauth-2025-04-20',
    );
  });

  it('adds the oauth beta when none present', () => {
    const out = buildUpstreamHeaders({}, token);
    expect(out['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('does not duplicate the oauth beta', () => {
    const out = buildUpstreamHeaders({ 'anthropic-beta': 'oauth-2025-04-20' }, token);
    expect(out['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('forwards unknown future headers untouched', () => {
    const out = buildUpstreamHeaders(
      { 'x-claude-code-session-id': 'abc', 'x-future-header': 'val' },
      token,
    );
    expect(out['x-claude-code-session-id']).toBe('abc');
    expect(out['x-future-header']).toBe('val');
  });
});
