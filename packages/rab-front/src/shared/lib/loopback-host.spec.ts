import { canonicalLoopbackUrl } from './loopback-host';

describe('canonicalLoopbackUrl (local dev cookie host)', () => {
  it('moves a localhost page onto the 127.0.0.1 API host, keeping path, query and hash', () => {
    expect(canonicalLoopbackUrl('http://localhost:5173/activate?token=abc#x', 'http://127.0.0.1:3000/rest/v1')).toBe(
      'http://127.0.0.1:5173/activate?token=abc#x',
    );
  });

  it('moves a 127.0.0.1 page onto a localhost API host', () => {
    expect(canonicalLoopbackUrl('http://127.0.0.1:5173/login', 'http://localhost:3000/rest/v1')).toBe('http://localhost:5173/login');
  });

  it('does nothing when the hosts already match', () => {
    expect(canonicalLoopbackUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:3000/rest/v1')).toBeNull();
  });

  it('never touches real hostnames or a remote API', () => {
    expect(canonicalLoopbackUrl('https://app.example.com/', 'https://api.example.com/rest/v1')).toBeNull();
    expect(canonicalLoopbackUrl('http://localhost:5173/', 'https://api.example.com/rest/v1')).toBeNull();
    expect(canonicalLoopbackUrl('http://192.168.1.4:5173/', 'http://127.0.0.1:3000/rest/v1')).toBeNull();
  });

  it('ignores malformed input', () => {
    expect(canonicalLoopbackUrl('not a url', 'http://127.0.0.1:3000')).toBeNull();
  });
});
